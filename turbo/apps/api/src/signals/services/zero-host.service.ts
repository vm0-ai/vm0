import { createHash } from "node:crypto";

import { command } from "ccstate";
import type {
  HostedArtifactKind,
  HostedSitePrepareRequest,
} from "@vm0/api-contracts/contracts/zero-host";
import {
  hostedDeployments,
  hostedSites,
  type HostedSiteManifest,
  type HostedSiteManifestFile,
} from "@vm0/db/schema/hosted-site";
import { and, eq, isNull } from "drizzle-orm";

import { env } from "../../lib/env";
import { type Db, writeDb$ } from "../external/db";
import {
  generateHostedSitesPresignedPutUrl,
  hostedSitesS3ObjectExists,
  putHostedSitesS3Object,
} from "../external/s3";
import { nowDate } from "../external/time";
import { recordHostedSiteArtifact$ } from "./run-uploaded-files.service";

const PUT_URL_TTL_SECONDS = 3600;
const MAX_HOSTED_SITE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_HOSTED_SITE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_PUBLIC_SLUG_ATTEMPTS = 5;

interface PrepareDeploymentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly body: HostedSitePrepareRequest;
}

interface CompleteDeploymentArgs {
  readonly orgId: string;
  readonly deploymentId: string;
}

type PrepareDeploymentResult =
  | {
      readonly status: "ok";
      readonly body: {
        readonly siteId: string;
        readonly deploymentId: string;
        readonly publicSlug: string;
        readonly url: string;
        readonly uploads: readonly {
          readonly path: string;
          readonly uploadUrl: string;
        }[];
      };
    }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type CompleteDeploymentResult =
  | {
      readonly status: "ok";
      readonly body: {
        readonly siteId: string;
        readonly deploymentId: string;
        readonly publicSlug: string;
        readonly url: string;
        readonly status: "ready";
      };
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

interface ActiveSitePointer {
  readonly version: 1;
  readonly publicSlug: string;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly spaFallback: boolean;
  readonly updatedAt: string;
}

type HostedSiteRow = typeof hostedSites.$inferSelect;
type HostedDeploymentRow = typeof hostedDeployments.$inferSelect;

type SiteDeploymentCreationResult =
  | {
      readonly kind: "ok";
      readonly site: HostedSiteRow;
      readonly deployment: HostedDeploymentRow;
    }
  | { readonly kind: "slug_conflict" };
type CreatedSiteDeployment = Extract<
  SiteDeploymentCreationResult,
  { readonly kind: "ok" }
>;

interface CreateHostedSiteDeploymentContext {
  readonly now: Date;
  readonly publicSlug: string;
  readonly url: string;
  readonly allowExistingPublicSlug: boolean;
}

interface HostedR2Config {
  readonly bucket: string;
}

type HostedR2ConfigResult =
  | { readonly status: "ok"; readonly config: HostedR2Config }
  | { readonly status: "config_error"; readonly message: string };

function hostedR2Config(): HostedR2ConfigResult {
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_BUCKET_NAME is not configured",
    };
  }
  if (!env("R2_HOSTED_SITES_ACCESS_KEY_ID")) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_ACCESS_KEY_ID is not configured",
    };
  }
  if (!env("R2_HOSTED_SITES_SECRET_ACCESS_KEY")) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_SECRET_ACCESS_KEY is not configured",
    };
  }
  return { status: "ok", config: { bucket } };
}

function publicUrl(publicSlug: string): string {
  return `${env("ZERO_HOST_SCHEME")}://${publicSlug}.${env("ZERO_HOST_DOMAIN")}`;
}

function activePointerKey(publicSlug: string): string {
  return `sites/${publicSlug}/active.json`;
}

function deploymentPrefix(publicSlug: string, deploymentId: string): string {
  return `sites/${publicSlug}/deployments/${deploymentId}`;
}

function orgSlugHash(orgId: string): string {
  return createHash("sha256").update(orgId).digest("hex").substring(0, 8);
}

function randomSlugSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").substring(0, 8);
}

function publicSlugForSite(
  site: string,
  orgId: string,
  slugSuffix: string,
): string {
  return `${site}-${orgSlugHash(orgId)}-${slugSuffix}`;
}

function fileKey(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function isSafeSitePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }
  if (path.includes("\\") || path.includes("\0")) {
    return false;
  }
  const segments = path.split("/").filter((segment) => {
    return segment.length > 0;
  });
  return !segments.some((segment) => {
    return segment === "." || segment === "..";
  });
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contentHash(files: readonly HostedSiteManifestFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => {
    return a.path.localeCompare(b.path);
  })) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function validateFiles(
  files: readonly HostedSitePrepareRequest["files"][number][],
): string | null {
  const seen = new Set<string>();
  let totalSize = 0;
  for (const file of files) {
    if (!isSafeSitePath(file.path)) {
      return `Invalid hosted-site path: ${file.path}`;
    }
    if (seen.has(file.path)) {
      return `Duplicate hosted-site path: ${file.path}`;
    }
    seen.add(file.path);
    if (file.size > MAX_HOSTED_SITE_FILE_BYTES) {
      return `Hosted-site file too large: ${file.path}`;
    }
    totalSize += file.size;
    if (totalSize > MAX_HOSTED_SITE_TOTAL_BYTES) {
      return "Hosted-site deployment is too large";
    }
  }
  if (!seen.has("/index.html")) {
    return "Hosted-site deployment must include /index.html";
  }
  return null;
}

function buildManifest(args: {
  readonly deploymentId: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly artifactKind: HostedArtifactKind;
  readonly spaFallback: boolean;
  readonly files: readonly HostedSitePrepareRequest["files"][number][];
  readonly createdAt: Date;
}): HostedSiteManifest {
  const manifestFiles: Record<string, HostedSiteManifestFile> = {};
  for (const file of args.files) {
    manifestFiles[file.path] = {
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      contentType: file.contentType,
      immutable: file.immutable,
    };
  }
  return {
    version: 1,
    deploymentId: args.deploymentId,
    siteId: args.siteId,
    publicSlug: args.publicSlug,
    createdAt: args.createdAt.toISOString(),
    artifactKind: args.artifactKind,
    spaFallback: args.spaFallback,
    files: manifestFiles,
  };
}

function hostedSiteArtifactArgs(deployment: HostedDeploymentRow) {
  const artifactKind = deployment.manifest.artifactKind ?? "hosted-site";
  return {
    runId: deployment.runId,
    userId: deployment.userId,
    orgId: deployment.orgId,
    artifactKind,
    siteId: deployment.siteId,
    deploymentId: deployment.id,
    publicSlug: deployment.manifest.publicSlug,
    url: deployment.url,
    fileCount: deployment.fileCount,
    sizeBytes: deployment.sizeBytes,
    entrypoint: deployment.entrypoint,
    spaFallback: deployment.spaFallback,
  };
}

function createHostedSiteDeployment(
  writeDb: Db,
  args: PrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
): Promise<SiteDeploymentCreationResult> {
  return writeDb.transaction(async (tx) => {
    const [existingPublicSite] = await tx
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.publicSlug, context.publicSlug),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);

    if (
      existingPublicSite &&
      (!context.allowExistingPublicSlug ||
        existingPublicSite.orgId !== args.orgId ||
        existingPublicSite.slug !== args.body.site)
    ) {
      return { kind: "slug_conflict" };
    }

    const [site] = await tx
      .insert(hostedSites)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        slug: args.body.site,
        publicSlug: context.publicSlug,
        createdFromRunId: args.runId,
        updatedAt: context.now,
      })
      .onConflictDoUpdate({
        target: [hostedSites.orgId, hostedSites.slug],
        set: { publicSlug: context.publicSlug, updatedAt: context.now },
      })
      .returning();
    if (!site) {
      throw new Error("Failed to create hosted site");
    }

    const deploymentId = crypto.randomUUID();
    const prefix = deploymentPrefix(context.publicSlug, deploymentId);
    const manifest = buildManifest({
      deploymentId,
      siteId: site.id,
      publicSlug: context.publicSlug,
      artifactKind: args.body.artifactKind,
      spaFallback: args.body.spaFallback,
      files: args.body.files,
      createdAt: context.now,
    });
    const files = Object.values(manifest.files);
    const [deployment] = await tx
      .insert(hostedDeployments)
      .values({
        id: deploymentId,
        siteId: site.id,
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        status: "uploading",
        r2Prefix: prefix,
        manifest,
        manifestHash: hashJson(manifest),
        contentHash: contentHash(files),
        entrypoint: "/index.html",
        spaFallback: args.body.spaFallback,
        fileCount: files.length,
        sizeBytes: files.reduce((sum, file) => {
          return sum + file.size;
        }, 0),
        url: context.url,
        updatedAt: context.now,
      })
      .returning();
    if (!deployment) {
      throw new Error("Failed to create hosted deployment");
    }

    return { kind: "ok", site, deployment };
  });
}

export const prepareHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: PrepareDeploymentArgs,
    signal: AbortSignal,
  ): Promise<PrepareDeploymentResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const fileError = validateFiles(args.body.files);
    if (fileError) {
      return { status: "bad_request", message: fileError };
    }

    const writeDb = set(writeDb$);
    const now = nowDate();
    let siteAndDeployment: CreatedSiteDeployment | null = null;
    let publicSlug = "";
    let url = "";

    if (args.body.slugSuffix) {
      publicSlug = publicSlugForSite(
        args.body.site,
        args.orgId,
        args.body.slugSuffix,
      );
      url = publicUrl(publicSlug);
      const result = await createHostedSiteDeployment(writeDb, args, {
        now,
        publicSlug,
        url,
        allowExistingPublicSlug: true,
      });
      signal.throwIfAborted();
      if (result.kind === "slug_conflict") {
        return {
          status: "conflict",
          message: `Hosted site slug is already in use: ${publicSlug}`,
        };
      }
      siteAndDeployment = result;
    } else {
      for (let attempt = 0; attempt < MAX_PUBLIC_SLUG_ATTEMPTS; attempt += 1) {
        publicSlug = publicSlugForSite(
          args.body.site,
          args.orgId,
          randomSlugSuffix(),
        );
        url = publicUrl(publicSlug);
        const result = await createHostedSiteDeployment(writeDb, args, {
          now,
          publicSlug,
          url,
          allowExistingPublicSlug: false,
        });
        signal.throwIfAborted();
        if (result.kind === "ok") {
          siteAndDeployment = result;
          break;
        }
      }
    }

    if (!siteAndDeployment) {
      return {
        status: "conflict",
        message: "Unable to allocate a unique hosted site slug",
      };
    }

    const uploads = await Promise.all(
      Object.values(siteAndDeployment.deployment.manifest.files).map(
        async (file) => {
          const uploadUrl = await get(
            generateHostedSitesPresignedPutUrl(
              hostedR2.config.bucket,
              fileKey(siteAndDeployment.deployment.r2Prefix, file.path),
              file.contentType,
              PUT_URL_TTL_SECONDS,
              true,
            ),
          );
          return { path: file.path, uploadUrl };
        },
      ),
    );
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: siteAndDeployment.site.id,
        deploymentId: siteAndDeployment.deployment.id,
        publicSlug,
        url,
        uploads,
      },
    };
  },
);

export const completeHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: CompleteDeploymentArgs,
    signal: AbortSignal,
  ): Promise<CompleteDeploymentResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const writeDb = set(writeDb$);
    const [deployment] = await writeDb
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, args.deploymentId),
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!deployment) {
      return { status: "not_found", message: "Hosted deployment not found" };
    }
    if (deployment.status !== "uploading" && deployment.status !== "ready") {
      return {
        status: "conflict",
        message: `Hosted deployment is ${deployment.status}`,
      };
    }

    const missingPath = await (async () => {
      for (const file of Object.values(deployment.manifest.files)) {
        const exists = await get(
          hostedSitesS3ObjectExists(
            hostedR2.config.bucket,
            fileKey(deployment.r2Prefix, file.path),
          ),
        );
        signal.throwIfAborted();
        if (!exists) {
          return file.path;
        }
      }
      return null;
    })();
    signal.throwIfAborted();

    if (missingPath) {
      return {
        status: "bad_request",
        message: `Hosted deployment file was not uploaded: ${missingPath}`,
      };
    }

    const manifestKey = `${deployment.r2Prefix}/manifest.json`;
    await get(
      putHostedSitesS3Object(
        hostedR2.config.bucket,
        manifestKey,
        JSON.stringify(deployment.manifest, null, 2),
        "application/json",
      ),
    );
    signal.throwIfAborted();

    const readyAt = nowDate();
    await writeDb.transaction(async (tx) => {
      await tx
        .update(hostedDeployments)
        .set({
          status: "ready",
          readyAt,
          updatedAt: readyAt,
          error: null,
        })
        .where(eq(hostedDeployments.id, deployment.id));
      await tx
        .update(hostedSites)
        .set({
          activeDeploymentId: deployment.id,
          updatedAt: readyAt,
        })
        .where(eq(hostedSites.id, deployment.siteId));
    });
    signal.throwIfAborted();

    const pointer: ActiveSitePointer = {
      version: 1,
      publicSlug: deployment.manifest.publicSlug,
      siteId: deployment.siteId,
      deploymentId: deployment.id,
      prefix: deployment.r2Prefix,
      manifestKey,
      spaFallback: deployment.spaFallback,
      updatedAt: readyAt.toISOString(),
    };
    await get(
      putHostedSitesS3Object(
        hostedR2.config.bucket,
        activePointerKey(deployment.manifest.publicSlug),
        JSON.stringify(pointer, null, 2),
        "application/json",
      ),
    );
    signal.throwIfAborted();

    await set(
      recordHostedSiteArtifact$,
      hostedSiteArtifactArgs(deployment),
      signal,
    );
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: deployment.siteId,
        deploymentId: deployment.id,
        publicSlug: deployment.manifest.publicSlug,
        url: deployment.url,
        status: "ready",
      },
    };
  },
);
