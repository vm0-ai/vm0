import { createHash } from "node:crypto";

import { command } from "ccstate";
import type {
  HostedArtifactKind,
  HostedSiteFilesResponse,
  HostedSiteDeploymentsResponse,
  HostedSitePrepareRequest,
} from "@vm0/api-contracts/contracts/zero-host";
import {
  hostedDeployments,
  hostedSites,
  type HostedSiteManifest,
  type HostedSiteManifestFile,
} from "@vm0/db/schema/hosted-site";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq, isNull, or } from "drizzle-orm";

import { env } from "../../lib/env";
import { type Db, writeDb$ } from "../external/db";
import {
  generateHostedSitesPresignedGetUrl,
  generateHostedSitesPresignedPutUrl,
  hostedSitesS3ObjectExists,
  putHostedSitesS3Object,
} from "../external/s3";
import { nowDate } from "../external/time";
import {
  scheduleArtifactPreviewRender$,
  type RenderArtifactPreviewArgs,
} from "./artifact-preview.service";
import { recordHostedSiteArtifact$ } from "./run-uploaded-files.service";

const PUT_URL_TTL_SECONDS = 3600;
const GET_URL_TTL_SECONDS = 3600;
const MAX_HOSTED_SITE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_HOSTED_SITE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_PUBLIC_SLUG_ATTEMPTS = 5;
const MAX_DNS_LABEL_LENGTH = 63;
const PUBLIC_SLUG_HASH_LENGTH = 4;
const PUBLIC_SLUG_HASH_SPACE = 36 ** PUBLIC_SLUG_HASH_LENGTH;
const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

interface PrepareDeploymentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly versionedArtifactsEnabled: boolean;
  readonly body: HostedSitePrepareRequest;
}

interface ScopedPrepareDeploymentArgs extends PrepareDeploymentArgs {
  readonly chatThreadId: string | null;
}

interface CompleteDeploymentArgs {
  readonly orgId: string;
  readonly runId?: string;
  readonly deploymentId: string;
}

interface GetHostedSiteFilesArgs {
  readonly orgId: string;
  readonly publicSlug: string;
  readonly version?: number;
}

interface GetHostedSiteDeploymentsArgs {
  readonly orgId: string;
  readonly runId?: string;
  readonly site: string;
}

type PrepareDeploymentResult =
  | {
      readonly status: "ok";
      readonly body: {
        readonly siteId: string;
        readonly deploymentId: string;
        readonly publicSlug: string;
        readonly url: string;
        readonly deploymentVersion?: number;
        readonly artifactUrl?: string;
        readonly aliasUrl?: string;
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
        readonly deploymentVersion?: number;
        readonly artifactUrl?: string;
        readonly aliasUrl?: string;
        readonly isActive?: boolean;
        readonly activeDeploymentVersion?: number;
        readonly status: "ready";
      };
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type GetHostedSiteFilesResult =
  | {
      readonly status: "ok";
      readonly body: HostedSiteFilesResponse;
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type GetHostedSiteDeploymentsResult =
  | {
      readonly status: "ok";
      readonly body: HostedSiteDeploymentsResponse;
    }
  | { readonly status: "not_found"; readonly message: string };

interface ActiveSitePointer {
  readonly version: 1;
  readonly publicSlug: string;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly deploymentVersion?: number;
  readonly artifactUrl?: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly spaFallback: boolean;
  readonly updatedAt: string;
}

type HostedSiteRow = typeof hostedSites.$inferSelect;
type HostedDeploymentRow = typeof hostedDeployments.$inferSelect;
type HostedSiteFile = HostedSitePrepareRequest["files"][number];

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

type CreateHostedSiteDeploymentContext =
  | {
      readonly kind: "legacy";
      readonly now: Date;
      readonly publicSlug: string;
      readonly url: string;
      readonly allowExistingPublicSlug: boolean;
    }
  | {
      readonly kind: "versioned";
      readonly now: Date;
    };

type LegacyHostedSiteDeploymentContext = Extract<
  CreateHostedSiteDeploymentContext,
  { readonly kind: "legacy" }
>;

interface HostedSiteAllocation {
  readonly site: HostedSiteRow;
  readonly deploymentVersion: number | null;
}

type HostedSiteFilesTargetResult =
  | {
      readonly status: "ok";
      readonly site: HostedSiteRow;
      readonly deployment: HostedDeploymentRow;
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string };

interface HostedSitePromotion {
  readonly activeDeploymentId: string | null;
  readonly activeDeploymentVersion: number | null;
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

function deploymentUrl(deploymentId: string): string {
  return publicUrl(`dpl-${deploymentId}`);
}

function activePointerKey(publicSlug: string): string {
  return `sites/${publicSlug}/active.json`;
}

function immutableDeploymentPointerKey(deploymentId: string): string {
  return `sites/deployments/${deploymentId}.json`;
}

function legacyDeploymentPrefix(
  publicSlug: string,
  deploymentId: string,
): string {
  return `sites/${publicSlug}/deployments/${deploymentId}`;
}

function versionedDeploymentPrefix(
  orgId: string,
  site: string,
  deploymentVersion: number,
): string {
  return `sites/orgs/${encodeURIComponent(orgId)}/${site}/versions/${deploymentVersion}`;
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

function shortPublicSlugHash(
  orgId: string,
  site: string,
  scopeKey: string,
  attempt: number,
): string {
  const value = createHash("sha256")
    .update(`${orgId}\0${site}\0${scopeKey}\0${attempt}`)
    .digest()
    .readUInt32BE(0);
  return (value % PUBLIC_SLUG_HASH_SPACE)
    .toString(36)
    .padStart(PUBLIC_SLUG_HASH_LENGTH, "0");
}

function isImmutableDeploymentHostLabel(value: string): boolean {
  return IMMUTABLE_DEPLOYMENT_HOST_PATTERN.test(value);
}

function versionedPublicSlugCandidate(
  site: string,
  orgId: string,
  scopeKey: string,
  attempt: number,
): string {
  if (attempt === 0 && !isImmutableDeploymentHostLabel(site)) {
    return site;
  }
  const hashAttempt = isImmutableDeploymentHostLabel(site)
    ? attempt
    : attempt - 1;
  const base = site.slice(
    0,
    MAX_DNS_LABEL_LENGTH - PUBLIC_SLUG_HASH_LENGTH - 1,
  );
  return `${base}-${shortPublicSlugHash(orgId, site, scopeKey, hashAttempt)}`;
}

function hostedSiteScopeKey(args: ScopedPrepareDeploymentArgs): string {
  return args.chatThreadId ?? "organization";
}

function hostedSiteRequestedSlug(site: HostedSiteRow): string {
  return site.requestedSlug ?? site.slug;
}

async function resolveChatThreadId(
  db: Db,
  runId: string | undefined,
): Promise<string | null> {
  if (runId === undefined) {
    return null;
  }
  const [run] = await db
    .select({ chatThreadId: zeroRuns.chatThreadId })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return run?.chatThreadId ?? null;
}

async function hostedDeploymentScopeError(
  db: Db,
  runId: string | undefined,
  owningChatThreadId: string | null,
): Promise<Extract<CompleteDeploymentResult, { status: "conflict" }> | null> {
  const chatThreadId = await resolveChatThreadId(db, runId);
  return owningChatThreadId === chatThreadId
    ? null
    : {
        status: "conflict",
        message: "Hosted deployment belongs to a different chat",
      };
}

type CompleteDeploymentLookupResult =
  | { readonly status: "ok"; readonly deployment: HostedDeploymentRow }
  | Extract<CompleteDeploymentResult, { status: "not_found" | "conflict" }>;

async function resolveHostedDeploymentForCompletion(
  db: Db,
  args: CompleteDeploymentArgs,
): Promise<CompleteDeploymentLookupResult> {
  const [ownedDeployment] = await db
    .select({
      deployment: hostedDeployments,
      chatThreadId: hostedSites.chatThreadId,
    })
    .from(hostedDeployments)
    .innerJoin(hostedSites, eq(hostedSites.id, hostedDeployments.siteId))
    .where(
      and(
        eq(hostedDeployments.id, args.deploymentId),
        eq(hostedDeployments.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!ownedDeployment) {
    return { status: "not_found", message: "Hosted deployment not found" };
  }
  const scopeError = await hostedDeploymentScopeError(
    db,
    args.runId,
    ownedDeployment.chatThreadId,
  );
  return (
    scopeError ?? {
      status: "ok",
      deployment: ownedDeployment.deployment,
    }
  );
}

async function findScopedHostedSite(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
  lock: boolean,
): Promise<HostedSiteRow | undefined> {
  const scopeCondition =
    args.chatThreadId === null
      ? isNull(hostedSites.chatThreadId)
      : eq(hostedSites.chatThreadId, args.chatThreadId);
  const query = db
    .select()
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.orgId, args.orgId),
        eq(hostedSites.requestedSlug, args.body.site),
        scopeCondition,
        isNull(hostedSites.deletedAt),
      ),
    );
  const [site] = lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  return site;
}

async function hasUnscopedHostedSiteConflict(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
): Promise<boolean> {
  if (args.chatThreadId === null) {
    return false;
  }
  const scopedSite = await findScopedHostedSite(db, args, false);
  if (scopedSite) {
    return false;
  }
  const [unscopedSite] = await db
    .select({ id: hostedSites.id })
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.orgId, args.orgId),
        isNull(hostedSites.chatThreadId),
        or(
          eq(hostedSites.requestedSlug, args.body.site),
          and(
            isNull(hostedSites.requestedSlug),
            eq(hostedSites.slug, args.body.site),
          ),
        ),
        isNull(hostedSites.deletedAt),
      ),
    )
    .limit(1);
  return unscopedSite !== undefined;
}

function deploymentVersionResponseFields(deployment: HostedDeploymentRow): {
  readonly deploymentVersion?: number;
  readonly artifactUrl?: string;
  readonly aliasUrl?: string;
} {
  if (
    deployment.deploymentVersion === null ||
    deployment.artifactUrl === null
  ) {
    return {};
  }
  return {
    deploymentVersion: deployment.deploymentVersion,
    artifactUrl: deployment.artifactUrl,
    aliasUrl: deployment.url,
  };
}

function hostedSiteUsesVersionedArtifacts(site: HostedSiteRow): boolean {
  return (
    site.activeDeploymentVersion !== null || site.nextDeploymentVersion > 1
  );
}

async function shouldUseVersionedArtifacts(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
): Promise<boolean> {
  if (args.versionedArtifactsEnabled) {
    return true;
  }
  const site = await findScopedHostedSite(db, args, false);
  return site !== undefined && hostedSiteUsesVersionedArtifacts(site);
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
  readonly site: string;
  readonly publicSlug: string;
  readonly deploymentVersion: number | null;
  readonly artifactKind: HostedArtifactKind;
  readonly spaFallback: boolean;
  readonly files: readonly HostedSiteFile[];
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
    site: args.site,
    publicSlug: args.publicSlug,
    ...(args.deploymentVersion === null
      ? {}
      : { deploymentVersion: args.deploymentVersion }),
    createdAt: args.createdAt.toISOString(),
    artifactKind: args.artifactKind,
    spaFallback: args.spaFallback,
    files: manifestFiles,
  };
}

function artifactPreviewArgs(
  deployment: HostedDeploymentRow,
  artifactRow: {
    readonly id: string;
    readonly previewImageUrl: string | null;
  } | null,
): RenderArtifactPreviewArgs | null {
  if (!artifactRow || artifactRow.previewImageUrl || !deployment.runId) {
    return null;
  }
  return {
    id: artifactRow.id,
    runId: deployment.runId,
    userId: deployment.userId,
    url: deployment.artifactUrl ?? deployment.url,
    contentType: "text/html",
    deploymentId: deployment.id,
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
    deploymentVersion: deployment.deploymentVersion,
    site: deployment.manifest.site ?? deployment.manifest.publicSlug,
    publicSlug: deployment.manifest.publicSlug,
    aliasUrl: deployment.url,
    url: deployment.artifactUrl ?? deployment.url,
    fileCount: deployment.fileCount,
    sizeBytes: deployment.sizeBytes,
    entrypoint: deployment.entrypoint,
    spaFallback: deployment.spaFallback,
  };
}

async function allocateLegacyHostedSite(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
  context: LegacyHostedSiteDeploymentContext,
): Promise<HostedSiteRow | null> {
  const existingSite = await findScopedHostedSite(db, args, true);
  const [existingPublicSite] = await db
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
      existingPublicSite.id !== existingSite?.id)
  ) {
    return null;
  }

  if (existingSite) {
    const [updatedSite] = await db
      .update(hostedSites)
      .set({ publicSlug: context.publicSlug, updatedAt: context.now })
      .where(eq(hostedSites.id, existingSite.id))
      .returning();
    if (!updatedSite) {
      throw new Error("Failed to update hosted site");
    }
    return updatedSite;
  }

  const scopeKey = hostedSiteScopeKey(args);
  for (let attempt = 0; attempt < MAX_PUBLIC_SLUG_ATTEMPTS; attempt += 1) {
    const compatibilitySlug = versionedPublicSlugCandidate(
      args.body.site,
      args.orgId,
      scopeKey,
      attempt,
    );
    const [createdSite] = await db
      .insert(hostedSites)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        slug: compatibilitySlug,
        requestedSlug: args.body.site,
        chatThreadId: args.chatThreadId,
        publicSlug: context.publicSlug,
        createdFromRunId: args.runId,
        updatedAt: context.now,
      })
      .onConflictDoNothing()
      .returning();
    if (createdSite) {
      return createdSite;
    }

    const concurrentSite = await findScopedHostedSite(db, args, true);
    if (concurrentSite) {
      const [publicSlugOwner] = await db
        .select({ id: hostedSites.id })
        .from(hostedSites)
        .where(
          and(
            eq(hostedSites.publicSlug, context.publicSlug),
            isNull(hostedSites.deletedAt),
          ),
        )
        .limit(1);
      if (
        publicSlugOwner &&
        (!context.allowExistingPublicSlug ||
          publicSlugOwner.id !== concurrentSite.id)
      ) {
        return null;
      }
      const [updatedSite] = await db
        .update(hostedSites)
        .set({ publicSlug: context.publicSlug, updatedAt: context.now })
        .where(eq(hostedSites.id, concurrentSite.id))
        .returning();
      if (!updatedSite) {
        throw new Error("Failed to update hosted site");
      }
      return updatedSite;
    }
  }
  return null;
}

async function findOrCreateVersionedHostedSite(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
  now: Date,
): Promise<HostedSiteRow | null> {
  const existingSite = await findScopedHostedSite(db, args, true);
  if (existingSite) {
    return existingSite;
  }

  const scopeKey = hostedSiteScopeKey(args);
  for (let attempt = 0; attempt < MAX_PUBLIC_SLUG_ATTEMPTS; attempt += 1) {
    const publicSlug = versionedPublicSlugCandidate(
      args.body.site,
      args.orgId,
      scopeKey,
      attempt,
    );
    const [createdSite] = await db
      .insert(hostedSites)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        slug: publicSlug,
        requestedSlug: args.body.site,
        chatThreadId: args.chatThreadId,
        publicSlug,
        createdFromRunId: args.runId,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (createdSite) {
      return createdSite;
    }

    const concurrentSite = await findScopedHostedSite(db, args, true);
    if (concurrentSite) {
      return concurrentSite;
    }
  }
  return null;
}

async function allocateVersionedHostedSite(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
  now: Date,
): Promise<HostedSiteAllocation | null> {
  const site = await findOrCreateVersionedHostedSite(db, args, now);
  if (!site) {
    return null;
  }
  const deploymentVersion = site.nextDeploymentVersion;
  const [updatedSite] = await db
    .update(hostedSites)
    .set({
      nextDeploymentVersion: deploymentVersion + 1,
      updatedAt: now,
    })
    .where(eq(hostedSites.id, site.id))
    .returning();
  if (!updatedSite) {
    throw new Error("Failed to allocate hosted deployment version");
  }
  return { site: updatedSite, deploymentVersion };
}

async function allocateHostedSite(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
): Promise<HostedSiteAllocation | null> {
  if (context.kind === "versioned") {
    return allocateVersionedHostedSite(db, args, context.now);
  }
  const site = await allocateLegacyHostedSite(db, args, context);
  return site ? { site, deploymentVersion: null } : null;
}

async function insertHostedDeployment(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
  allocation: HostedSiteAllocation,
): Promise<HostedDeploymentRow> {
  const { deploymentVersion, site } = allocation;
  const deploymentId = crypto.randomUUID();
  const aliasUrl =
    context.kind === "legacy" ? context.url : publicUrl(site.publicSlug);
  const artifactUrl =
    deploymentVersion === null ? null : deploymentUrl(deploymentId);
  const prefix =
    deploymentVersion === null
      ? legacyDeploymentPrefix(site.publicSlug, deploymentId)
      : versionedDeploymentPrefix(args.orgId, site.slug, deploymentVersion);
  const manifest = buildManifest({
    deploymentId,
    siteId: site.id,
    site: args.body.site,
    publicSlug: site.publicSlug,
    deploymentVersion,
    artifactKind: args.body.artifactKind,
    spaFallback: args.body.spaFallback,
    files: args.body.files,
    createdAt: context.now,
  });
  const files = Object.values(manifest.files);
  const [deployment] = await db
    .insert(hostedDeployments)
    .values({
      id: deploymentId,
      siteId: site.id,
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      status: "uploading",
      deploymentVersion,
      artifactUrl,
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
      url: aliasUrl,
      updatedAt: context.now,
    })
    .returning();
  if (!deployment) {
    throw new Error("Failed to create hosted deployment");
  }
  return deployment;
}

function createHostedSiteDeployment(
  writeDb: Db,
  args: ScopedPrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
): Promise<SiteDeploymentCreationResult> {
  return writeDb.transaction(async (tx) => {
    const allocation = await allocateHostedSite(tx, args, context);
    if (!allocation) {
      return { kind: "slug_conflict" };
    }
    const deployment = await insertHostedDeployment(
      tx,
      args,
      context,
      allocation,
    );
    return { kind: "ok", site: allocation.site, deployment };
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
    const chatThreadId = await resolveChatThreadId(writeDb, args.runId);
    signal.throwIfAborted();
    const scopedArgs: ScopedPrepareDeploymentArgs = {
      ...args,
      chatThreadId,
    };
    if (await hasUnscopedHostedSiteConflict(writeDb, scopedArgs)) {
      return {
        status: "conflict",
        message: `Hosted site slug "${args.body.site}" is owned outside this chat. Choose a different --site value and rerun the same zero host command.`,
      };
    }
    signal.throwIfAborted();
    const now = nowDate();
    const useVersionedArtifacts = await shouldUseVersionedArtifacts(
      writeDb,
      scopedArgs,
    );
    signal.throwIfAborted();
    let siteAndDeployment: CreatedSiteDeployment | null = null;
    let publicSlug = "";
    let url = "";

    if (useVersionedArtifacts) {
      const result = await createHostedSiteDeployment(writeDb, scopedArgs, {
        kind: "versioned",
        now,
      });
      signal.throwIfAborted();
      if (result.kind === "ok") {
        siteAndDeployment = result;
        publicSlug = result.site.publicSlug;
        url = result.deployment.url;
      }
    } else if (args.body.slugSuffix) {
      publicSlug = publicSlugForSite(
        args.body.site,
        args.orgId,
        args.body.slugSuffix,
      );
      url = publicUrl(publicSlug);
      const result = await createHostedSiteDeployment(writeDb, scopedArgs, {
        kind: "legacy",
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
        const result = await createHostedSiteDeployment(writeDb, scopedArgs, {
          kind: "legacy",
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
        ...deploymentVersionResponseFields(siteAndDeployment.deployment),
        uploads,
      },
    };
  },
);

const firstMissingHostedDeploymentPath$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly deployment: HostedDeploymentRow;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    for (const file of Object.values(args.deployment.manifest.files)) {
      const exists = await get(
        hostedSitesS3ObjectExists(
          args.bucket,
          fileKey(args.deployment.r2Prefix, file.path),
        ),
      );
      signal.throwIfAborted();
      if (!exists) {
        return file.path;
      }
    }
    return null;
  },
);

function activeSitePointerForDeployment(
  deployment: HostedDeploymentRow,
  manifestKey: string,
  readyAt: Date,
): ActiveSitePointer {
  return {
    version: 1,
    publicSlug: deployment.manifest.publicSlug,
    siteId: deployment.siteId,
    deploymentId: deployment.id,
    ...(deployment.deploymentVersion === null
      ? {}
      : { deploymentVersion: deployment.deploymentVersion }),
    ...(deployment.artifactUrl === null
      ? {}
      : { artifactUrl: deployment.artifactUrl }),
    prefix: deployment.r2Prefix,
    manifestKey,
    spaFallback: deployment.spaFallback,
    updatedAt: readyAt.toISOString(),
  };
}

const promoteHostedSiteDeployment$ = command(
  (
    { get, set },
    args: {
      readonly bucket: string;
      readonly deployment: HostedDeploymentRow;
      readonly orgId: string;
      readonly pointer: ActiveSitePointer;
      readonly readyAt: Date;
    },
    signal: AbortSignal,
  ): Promise<HostedSitePromotion> => {
    const writeDb = set(writeDb$);
    return writeDb.transaction(async (tx) => {
      const [site] = await tx
        .select()
        .from(hostedSites)
        .where(
          and(
            eq(hostedSites.id, args.deployment.siteId),
            eq(hostedSites.orgId, args.orgId),
          ),
        )
        .for("update")
        .limit(1);
      if (!site) {
        throw new Error("Hosted site not found for deployment");
      }

      const shouldPromote =
        args.deployment.deploymentVersion === null
          ? site.activeDeploymentVersion === null
          : site.activeDeploymentVersion === null ||
            args.deployment.deploymentVersion >= site.activeDeploymentVersion;
      if (shouldPromote) {
        await get(
          putHostedSitesS3Object(
            args.bucket,
            activePointerKey(args.deployment.manifest.publicSlug),
            JSON.stringify(args.pointer, null, 2),
            "application/json",
          ),
        );
        signal.throwIfAborted();
      }

      await tx
        .update(hostedDeployments)
        .set({
          status: "ready",
          readyAt: args.readyAt,
          updatedAt: args.readyAt,
          error: null,
        })
        .where(eq(hostedDeployments.id, args.deployment.id));
      if (shouldPromote) {
        await tx
          .update(hostedSites)
          .set({
            activeDeploymentId: args.deployment.id,
            activeDeploymentVersion: args.deployment.deploymentVersion,
            updatedAt: args.readyAt,
          })
          .where(eq(hostedSites.id, args.deployment.siteId));
      }

      return {
        activeDeploymentId: shouldPromote
          ? args.deployment.id
          : site.activeDeploymentId,
        activeDeploymentVersion: shouldPromote
          ? args.deployment.deploymentVersion
          : site.activeDeploymentVersion,
      };
    });
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
    const deploymentResult = await resolveHostedDeploymentForCompletion(
      writeDb,
      args,
    );
    signal.throwIfAborted();
    if (deploymentResult.status !== "ok") {
      return deploymentResult;
    }
    const { deployment } = deploymentResult;
    if (deployment.status !== "uploading" && deployment.status !== "ready") {
      return {
        status: "conflict",
        message: `Hosted deployment is ${deployment.status}`,
      };
    }

    const missingPath = await set(
      firstMissingHostedDeploymentPath$,
      {
        bucket: hostedR2.config.bucket,
        deployment,
      },
      signal,
    );
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
    const pointer = activeSitePointerForDeployment(
      deployment,
      manifestKey,
      readyAt,
    );

    if (deployment.deploymentVersion !== null) {
      await get(
        putHostedSitesS3Object(
          hostedR2.config.bucket,
          immutableDeploymentPointerKey(deployment.id),
          JSON.stringify(pointer, null, 2),
          "application/json",
        ),
      );
      signal.throwIfAborted();
    }

    const promotion = await set(
      promoteHostedSiteDeployment$,
      {
        bucket: hostedR2.config.bucket,
        deployment,
        orgId: args.orgId,
        pointer,
        readyAt,
      },
      signal,
    );
    signal.throwIfAborted();

    const artifactRow = await set(
      recordHostedSiteArtifact$,
      hostedSiteArtifactArgs(deployment),
      signal,
    );
    signal.throwIfAborted();

    // Render the artifact preview as soon as the deploy is recorded. Detached
    // via waitUntil so it survives the response; failures leave the preview
    // empty without blocking the deployment.
    set(
      scheduleArtifactPreviewRender$,
      artifactPreviewArgs(deployment, artifactRow),
    );

    return {
      status: "ok",
      body: {
        siteId: deployment.siteId,
        deploymentId: deployment.id,
        publicSlug: deployment.manifest.publicSlug,
        url: deployment.url,
        ...deploymentVersionResponseFields(deployment),
        ...(deployment.deploymentVersion === null
          ? {}
          : {
              isActive: promotion.activeDeploymentId === deployment.id,
              ...(promotion.activeDeploymentVersion === null
                ? {}
                : {
                    activeDeploymentVersion: promotion.activeDeploymentVersion,
                  }),
            }),
        status: "ready",
      },
    };
  },
);

async function loadImmutableHostedSiteFilesTarget(
  db: Db,
  args: GetHostedSiteFilesArgs,
  deploymentId: string,
  signal: AbortSignal,
): Promise<HostedSiteFilesTargetResult> {
  const [deployment] = await db
    .select()
    .from(hostedDeployments)
    .where(
      and(
        eq(hostedDeployments.id, deploymentId),
        eq(hostedDeployments.orgId, args.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!deployment) {
    return { status: "not_found", message: "Hosted deployment not found" };
  }
  if (
    args.version !== undefined &&
    deployment.deploymentVersion !== args.version
  ) {
    return {
      status: "not_found",
      message: `Hosted deployment version not found: ${args.version}`,
    };
  }

  const [site] = await db
    .select()
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.id, deployment.siteId),
        eq(hostedSites.orgId, args.orgId),
        isNull(hostedSites.deletedAt),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return site
    ? { status: "ok", site, deployment }
    : { status: "not_found", message: "Hosted site not found" };
}

async function loadAliasedHostedSiteFilesTarget(
  db: Db,
  args: GetHostedSiteFilesArgs,
  signal: AbortSignal,
): Promise<HostedSiteFilesTargetResult> {
  const [site] = await db
    .select()
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.publicSlug, args.publicSlug),
        eq(hostedSites.orgId, args.orgId),
        isNull(hostedSites.deletedAt),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!site) {
    return { status: "not_found", message: "Hosted site not found" };
  }
  let deployment: HostedDeploymentRow | undefined;
  if (args.version === undefined) {
    if (!site.activeDeploymentId) {
      return {
        status: "conflict",
        message: "Hosted site has no active deployment",
      };
    }
    [deployment] = await db
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, site.activeDeploymentId),
          eq(hostedDeployments.siteId, site.id),
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .limit(1);
  } else {
    [deployment] = await db
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.deploymentVersion, args.version),
          eq(hostedDeployments.siteId, site.id),
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .limit(1);
  }
  signal.throwIfAborted();
  if (!deployment) {
    return {
      status: "not_found",
      message:
        args.version === undefined
          ? "Active hosted deployment not found"
          : `Hosted deployment version not found: ${args.version}`,
    };
  }
  return { status: "ok", site, deployment };
}

function loadHostedSiteFilesTarget(
  db: Db,
  args: GetHostedSiteFilesArgs,
  signal: AbortSignal,
): Promise<HostedSiteFilesTargetResult> {
  const deploymentId = IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(
    args.publicSlug,
  )?.[1];
  return deploymentId
    ? loadImmutableHostedSiteFilesTarget(db, args, deploymentId, signal)
    : loadAliasedHostedSiteFilesTarget(db, args, signal);
}

export const getHostedSiteFiles$ = command(
  async (
    { get, set },
    args: GetHostedSiteFilesArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteFilesResult> => {
    const writeDb = set(writeDb$);
    const target = await loadHostedSiteFilesTarget(writeDb, args, signal);
    signal.throwIfAborted();
    if (target.status !== "ok") {
      return target;
    }
    const { deployment, site } = target;
    if (deployment.status !== "ready") {
      return {
        status: "conflict",
        message: `Hosted deployment is ${deployment.status}`,
      };
    }

    const manifestFiles = Object.values(deployment.manifest.files).sort(
      (a, b) => {
        return a.path.localeCompare(b.path);
      },
    );
    signal.throwIfAborted();

    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const files = await Promise.all(
      manifestFiles.map(async (file) => {
        const downloadUrl = await get(
          generateHostedSitesPresignedGetUrl(
            hostedR2.config.bucket,
            fileKey(deployment.r2Prefix, file.path),
            GET_URL_TTL_SECONDS,
            true,
          ),
        );
        return { ...file, downloadUrl };
      }),
    );
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: site.id,
        deploymentId: deployment.id,
        publicSlug: site.publicSlug,
        url: deployment.url,
        ...deploymentVersionResponseFields(deployment),
        fileCount: deployment.fileCount,
        size: deployment.sizeBytes,
        files,
      },
    };
  },
);

export const getHostedSiteDeployments$ = command(
  async (
    { set },
    args: GetHostedSiteDeploymentsArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteDeploymentsResult> => {
    const writeDb = set(writeDb$);
    const chatThreadId = await resolveChatThreadId(writeDb, args.runId);
    signal.throwIfAborted();
    const scopeCondition =
      chatThreadId === null
        ? isNull(hostedSites.chatThreadId)
        : eq(hostedSites.chatThreadId, chatThreadId);
    const [site] = await writeDb
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.orgId, args.orgId),
          eq(hostedSites.requestedSlug, args.site),
          scopeCondition,
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!site) {
      return { status: "not_found", message: "Hosted site not found" };
    }

    const deployments = await writeDb
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.siteId, site.id),
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .orderBy(desc(hostedDeployments.createdAt));
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: site.id,
        site: hostedSiteRequestedSlug(site),
        publicSlug: site.publicSlug,
        aliasUrl: publicUrl(site.publicSlug),
        activeDeploymentId: site.activeDeploymentId,
        activeDeploymentVersion: site.activeDeploymentVersion,
        deployments: deployments.map((deployment) => {
          return {
            deploymentId: deployment.id,
            deploymentVersion: deployment.deploymentVersion,
            artifactUrl: deployment.artifactUrl,
            status: deployment.status,
            isActive: deployment.id === site.activeDeploymentId,
            createdAt: deployment.createdAt.toISOString(),
            readyAt: deployment.readyAt?.toISOString() ?? null,
          };
        }),
      },
    };
  },
);
