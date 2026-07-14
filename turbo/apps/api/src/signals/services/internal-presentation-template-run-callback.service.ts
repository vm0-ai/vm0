import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  getPresentationTemplatePackageStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import {
  presentationTemplateImports,
  presentationTemplateRevisions,
  presentationTemplates,
} from "@vm0/db/schema/presentation-template";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";

import { extractBuffersFromTarGz } from "../../lib/tar";
import { env } from "../../lib/env";
import { writeDb$, type Db } from "../external/db";
import { downloadS3BufferWithMaxBytes, putS3Object } from "../external/s3";
import { nowDate } from "../external/time";
import { safeJsonParse, safeSync } from "../utils";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { PRESENTATION_TEMPLATE_COMPILER_VERSION } from "./presentation-template-import.service";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_PACKAGE_BYTES = 200 * 1024 * 1024;

const callbackPayloadSchema = z
  .object({
    templateId: z.string().uuid(),
    importId: z.string().uuid(),
  })
  .strict();

const compiledManifestSchema = z
  .object({
    importId: z.string().uuid(),
    templateId: z.string().uuid(),
    sourceVersionId: z.string().length(64),
    slideCount: z.number().int().positive().max(500),
    aspectRatio: z.string().min(1).max(64),
    fonts: z.array(z.string().min(1).max(256)).max(256),
    fontFallbacks: z.record(z.string(), z.string()),
    colors: z.array(z.string().min(1).max(64)).max(256),
    excludedContent: z.array(z.string().min(1).max(256)).max(256),
    packageFiles: z.array(z.string().min(1).max(512)).max(10_000),
    metadata: z.record(z.string(), z.json()),
  })
  .strict();

const REQUIRED_PACKAGE_FILES = [
  "AGENT_RUNBOOK.md",
  "template-manifest.json",
  "design-tokens.json",
  "provenance.json",
  "renderer/README.md",
] as const;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface LoadedImport {
  readonly id: string;
  readonly orgId: string;
  readonly templateId: string;
  readonly status: string;
  readonly sourceVersionId: string | null;
  readonly createdBy: string;
  readonly compileRunId: string | null;
}

async function loadImport(
  db: Db,
  args: { readonly importId: string; readonly templateId: string },
): Promise<LoadedImport | null> {
  const [row] = await db
    .select({
      id: presentationTemplateImports.id,
      orgId: presentationTemplateImports.orgId,
      templateId: presentationTemplateImports.templateId,
      status: presentationTemplateImports.status,
      sourceVersionId: presentationTemplateImports.sourceStorageVersionId,
      createdBy: presentationTemplateImports.createdBy,
      compileRunId: presentationTemplateImports.compileRunId,
    })
    .from(presentationTemplateImports)
    .where(
      and(
        eq(presentationTemplateImports.id, args.importId),
        eq(presentationTemplateImports.templateId, args.templateId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function failImport(
  db: Db,
  importId: string,
  code: string,
  message: string,
): Promise<void> {
  const timestamp = nowDate();
  await db
    .update(presentationTemplateImports)
    .set({
      status: "failed",
      errorCode: code,
      errorMessage: message,
      completedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(presentationTemplateImports.id, importId),
        inArray(presentationTemplateImports.status, ["queued", "processing"]),
      ),
    );
}

async function handleImportFailure(
  db: Db,
  importId: string,
  code: string,
  message: string,
  signal: AbortSignal,
): Promise<InternalRunCallbackDispatchResult> {
  await failImport(db, importId, code, message);
  signal.throwIfAborted();
  return { success: true };
}

function validatePackageFiles(
  files: readonly { readonly path: string; readonly content: Buffer }[],
): string | null {
  const paths = new Set(
    files.map((file) => {
      return file.path;
    }),
  );
  if (paths.size !== files.length) {
    return "Compiled package contains duplicate paths";
  }
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!paths.has(required)) {
      return `Compiled package is missing ${required}`;
    }
  }
  if (
    !files.some((file) => {
      return /^qa\/previews\/slide-\d+\.png$/.test(file.path);
    })
  ) {
    return "Compiled package has no slide preview";
  }
  if (
    files.some((file) => {
      return (
        /^qa\/previews\/slide-\d+\.png$/.test(file.path) &&
        !file.content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      );
    })
  ) {
    return "Compiled package contains an invalid slide preview";
  }
  if (
    files.some((file) => {
      const lowerPath = file.path.toLowerCase();
      return (
        file.path.startsWith("/") ||
        lowerPath.endsWith(".pptx") ||
        lowerPath.startsWith("analysis/") ||
        lowerPath.startsWith("ppt/") ||
        file.path.split("/").some((segment) => {
          return segment === "..";
        })
      );
    })
  ) {
    return "Compiled package contains an unsafe path";
  }
  return null;
}

function manifestFile(
  files: readonly { readonly path: string; readonly content: Buffer }[],
) {
  return files.find((file) => {
    return file.path === "template-manifest.json";
  });
}

function previewFiles(
  files: readonly { readonly path: string; readonly content: Buffer }[],
) {
  return files
    .filter((file) => {
      return /^qa\/previews\/slide-\d+\.png$/.test(file.path);
    })
    .sort((left, right) => {
      return left.path.localeCompare(right.path, undefined, { numeric: true });
    });
}

function runtimePackageFiles(
  files: readonly { readonly path: string; readonly content: Buffer }[],
  manifest: z.infer<typeof compiledManifestSchema>,
) {
  const runtimeFiles = files.filter((file) => {
    return !file.path.startsWith("qa/previews/");
  });
  const packageFiles = runtimeFiles.map((file) => {
    return file.path;
  });
  return runtimeFiles.map((file) => {
    return file.path === "template-manifest.json"
      ? {
          path: file.path,
          content: Buffer.from(
            JSON.stringify({ ...manifest, packageFiles }, null, 2),
            "utf8",
          ),
        }
      : file;
  });
}

function extractPackageArchive(archive: Buffer) {
  return safeSync(() => {
    return extractBuffersFromTarGz(
      archive,
      undefined,
      MAX_UNCOMPRESSED_PACKAGE_BYTES,
    );
  });
}

async function loadPackageVersion(
  db: Db,
  loadedImport: LoadedImport,
  packageStorageName: string,
): Promise<{ readonly s3Key: string } | null> {
  const [packageVersion] = await db
    .select({ s3Key: storageVersions.s3Key })
    .from(storages)
    .innerJoin(storageVersions, eq(storageVersions.id, storages.headVersionId))
    .where(
      and(
        eq(storages.orgId, loadedImport.orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.type, "volume"),
        eq(storages.name, packageStorageName),
      ),
    )
    .limit(1);
  return packageVersion ?? null;
}

async function finalizeRevision(
  db: Db,
  args: {
    readonly loadedImport: LoadedImport;
    readonly packageVersionId: string;
    readonly previewPrefix: string;
    readonly compiledManifest: z.infer<typeof compiledManifestSchema>;
    readonly packageFiles: readonly string[];
    readonly revisionId: string;
  },
): Promise<boolean> {
  const timestamp = nowDate();
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${args.loadedImport.templateId}))`,
    );
    const [current] = await tx
      .select({
        status: presentationTemplateImports.status,
        deletedAt: presentationTemplates.deletedAt,
      })
      .from(presentationTemplateImports)
      .innerJoin(
        presentationTemplates,
        eq(presentationTemplates.id, presentationTemplateImports.templateId),
      )
      .where(eq(presentationTemplateImports.id, args.loadedImport.id))
      .limit(1);
    if (
      !current ||
      current.deletedAt !== null ||
      (current.status !== "queued" && current.status !== "processing")
    ) {
      return false;
    }
    const [numberRow] = await tx
      .select({
        value: sql<number>`COALESCE(MAX(${presentationTemplateRevisions.revisionNumber}), 0)::int`,
      })
      .from(presentationTemplateRevisions)
      .where(
        eq(
          presentationTemplateRevisions.templateId,
          args.loadedImport.templateId,
        ),
      );
    const revisionNumber = (numberRow?.value ?? 0) + 1;
    if (!args.loadedImport.sourceVersionId) {
      throw new Error("Committed import is missing its source storage version");
    }

    const [created] = await tx
      .insert(presentationTemplateRevisions)
      .values({
        id: args.revisionId,
        orgId: args.loadedImport.orgId,
        templateId: args.loadedImport.templateId,
        revisionNumber,
        sourceImportId: args.loadedImport.id,
        sourceStorageVersionId: args.loadedImport.sourceVersionId,
        packageStorageVersionId: args.packageVersionId,
        compilerVersion: PRESENTATION_TEMPLATE_COMPILER_VERSION,
        manifest: {
          version: 1,
          templateId: args.loadedImport.templateId,
          revisionNumber,
          sourceVersionId: args.loadedImport.sourceVersionId,
          compilerVersion: PRESENTATION_TEMPLATE_COMPILER_VERSION,
          slideCount: args.compiledManifest.slideCount,
          aspectRatio: args.compiledManifest.aspectRatio,
          fonts: args.compiledManifest.fonts,
          fontFallbacks: args.compiledManifest.fontFallbacks,
          colors: args.compiledManifest.colors,
          excludedContent: args.compiledManifest.excludedContent,
          packageFiles: args.packageFiles,
          metadata: args.compiledManifest.metadata,
        },
        previewS3Prefix: args.previewPrefix,
        createdBy: args.loadedImport.createdBy,
        createdAt: timestamp,
      })
      .onConflictDoNothing({
        target: presentationTemplateRevisions.sourceImportId,
      })
      .returning({ id: presentationTemplateRevisions.id });
    if (!created) {
      return false;
    }
    await tx
      .update(presentationTemplateImports)
      .set({
        status: "succeeded",
        completedAt: timestamp,
        updatedAt: timestamp,
        errorCode: null,
        errorMessage: null,
      })
      .where(eq(presentationTemplateImports.id, args.loadedImport.id));
    await tx
      .update(presentationTemplates)
      .set({
        activeRevisionId: sql`COALESCE(${presentationTemplates.activeRevisionId}, ${args.revisionId})`,
        updatedAt: timestamp,
        updatedBy: args.loadedImport.createdBy,
      })
      .where(eq(presentationTemplates.id, args.loadedImport.templateId));
    return true;
  });
}

const finalizeCompletedCallback$ = command(
  async (
    { get, set },
    args: { readonly db: Db; readonly loadedImport: LoadedImport },
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    const packageStorageName = getPresentationTemplatePackageStorageName(
      args.loadedImport.templateId,
    );
    const packageVersion = await loadPackageVersion(
      args.db,
      args.loadedImport,
      packageStorageName,
    );
    signal.throwIfAborted();
    if (!packageVersion) {
      return await handleImportFailure(
        args.db,
        args.loadedImport.id,
        "compile_failed",
        "Template analysis did not produce a reusable package",
        signal,
      );
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const archive = await get(
      downloadS3BufferWithMaxBytes(
        bucket,
        `${packageVersion.s3Key}/archive.tar.gz`,
        MAX_PACKAGE_BYTES,
      ),
    );
    signal.throwIfAborted();
    const extracted = extractPackageArchive(archive);
    if ("error" in extracted) {
      return await handleImportFailure(
        args.db,
        args.loadedImport.id,
        "validation_failed",
        "Compiled template package is invalid or too large",
        signal,
      );
    }
    const files = extracted.ok;
    const packageError = validatePackageFiles(files);
    if (packageError) {
      return await handleImportFailure(
        args.db,
        args.loadedImport.id,
        "validation_failed",
        packageError,
        signal,
      );
    }
    const rawManifest = manifestFile(files);
    if (!rawManifest) {
      throw new Error("Validated package manifest disappeared");
    }
    const parsedManifest = compiledManifestSchema.safeParse(
      safeJsonParse(rawManifest.content.toString("utf8")),
    );
    if (
      !parsedManifest.success ||
      parsedManifest.data.importId !== args.loadedImport.id ||
      parsedManifest.data.templateId !== args.loadedImport.templateId ||
      parsedManifest.data.sourceVersionId !== args.loadedImport.sourceVersionId
    ) {
      return await handleImportFailure(
        args.db,
        args.loadedImport.id,
        "validation_failed",
        "Compiled template metadata does not match the uploaded source",
        signal,
      );
    }
    const previews = previewFiles(files);
    if (previews.length !== parsedManifest.data.slideCount) {
      return await handleImportFailure(
        args.db,
        args.loadedImport.id,
        "validation_failed",
        "Compiled template preview count does not match its metadata",
        signal,
      );
    }

    const revisionId = randomUUID();
    const previewPrefix = `presentation-template-previews/${args.loadedImport.orgId}/${args.loadedImport.templateId}/${revisionId}`;
    await Promise.all(
      previews.map(async (preview, index) => {
        await get(
          putS3Object(
            bucket,
            `${previewPrefix}/${index}.png`,
            preview.content,
            "image/png",
          ),
        );
      }),
    );
    signal.throwIfAborted();

    const runtimeFiles = runtimePackageFiles(files, parsedManifest.data);
    const runtimePackage = await set(
      uploadVolumeServerSide$,
      {
        orgId: args.loadedImport.orgId,
        storageName: packageStorageName,
        files: runtimeFiles,
      },
      signal,
    );
    signal.throwIfAborted();

    await finalizeRevision(args.db, {
      loadedImport: args.loadedImport,
      packageVersionId: runtimePackage.versionId,
      previewPrefix,
      compiledManifest: parsedManifest.data,
      packageFiles: runtimeFiles.map((file) => {
        return file.path;
      }),
      revisionId,
    });
    signal.throwIfAborted();
    return { success: true };
  },
);

export const handlePresentationTemplateInternalCallback$ = command(
  async (
    { set },
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    if (callback.status === "progress") {
      return { success: true, skipped: true };
    }
    const parsedPayload = callbackPayloadSchema.safeParse(callback.payload);
    if (!parsedPayload.success) {
      return {
        success: false,
        error: "Invalid presentation template callback payload",
      };
    }

    const db = set(writeDb$);
    const loadedImport = await loadImport(db, parsedPayload.data);
    signal.throwIfAborted();
    if (!loadedImport) {
      return { success: true, skipped: true };
    }
    if (
      loadedImport.status !== "queued" &&
      loadedImport.status !== "processing"
    ) {
      return { success: true, skipped: true };
    }
    if (
      loadedImport.compileRunId !== null &&
      loadedImport.compileRunId !== callback.runId
    ) {
      return { success: true, skipped: true };
    }
    if (callback.status === "failed") {
      await failImport(
        db,
        loadedImport.id,
        "compile_failed",
        "vm0 could not analyze this PowerPoint file",
      );
      signal.throwIfAborted();
      return { success: true };
    }

    return await set(finalizeCompletedCallback$, { db, loadedImport }, signal);
  },
);

export async function handlePresentationTemplateInternalCallbackWithoutCcstate(
  db: Db,
  callback: InternalRunCallbackEnvelope,
): Promise<InternalRunCallbackDispatchResult> {
  const parsedPayload = callbackPayloadSchema.safeParse(callback.payload);
  if (!parsedPayload.success) {
    return {
      success: false,
      error: "Invalid presentation template callback payload",
    };
  }
  if (callback.status !== "failed") {
    return {
      success: false,
      error:
        "Completed presentation template callbacks require the signal runtime",
    };
  }
  const loadedImport = await loadImport(db, parsedPayload.data);
  if (
    !loadedImport ||
    (loadedImport.status !== "queued" &&
      loadedImport.status !== "processing") ||
    (loadedImport.compileRunId !== null &&
      loadedImport.compileRunId !== callback.runId)
  ) {
    return { success: true, skipped: true };
  }
  await failImport(
    db,
    loadedImport.id,
    "compile_failed",
    "vm0 could not analyze this PowerPoint file",
  );
  return { success: true };
}
