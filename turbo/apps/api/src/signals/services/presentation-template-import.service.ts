import { randomBytes } from "node:crypto";

import AdmZip from "adm-zip";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  getPresentationTemplatePackageStorageName,
  getPresentationTemplateSourceStorageName,
} from "@vm0/core/storage-names";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import {
  presentationTemplateImports,
  presentationTemplates,
} from "@vm0/db/schema/presentation-template";
import { command } from "ccstate";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import type { AuthContext } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  downloadS3BufferWithMaxBytes,
  generatePresignedPutUrl,
  listS3Objects,
} from "../external/s3";
import { now, nowDate } from "../external/time";
import { safeSync, settle } from "../utils";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";
import { createZeroIntegrationRun$ } from "./zero-runs-create.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

const MAX_PPTX_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_RELATIONSHIP_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const UPLOAD_TTL_SECONDS = 60 * 60;
export const PRESENTATION_TEMPLATE_COMPILER_VERSION = "pptx-runbook-v1";

interface TemplateAuth {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: "admin" | "member";
}

interface ImportValidationError {
  readonly code:
    | "invalid_pptx"
    | "encrypted_pptx"
    | "unsupported_embedded_object"
    | "too_large";
  readonly message: string;
}

function uploadPrefix(args: {
  readonly orgId: string;
  readonly templateId: string;
  readonly importId: string;
}): string {
  return `presentation-template-imports/${args.orgId}/${args.templateId}/${args.importId}/`;
}

function compilerPrompt(args: {
  readonly templateId: string;
  readonly importId: string;
  readonly sourceVersionId: string;
  readonly packageStorageName: string;
}): string {
  return [
    "Compile the mounted PowerPoint deck into a reusable vm0 presentation runbook package.",
    "This is a deterministic internal compilation task. Do not ask questions and do not reuse slide copy, speaker notes, comments, hidden-slide content, or document metadata.",
    "Do not fetch external resources. Do not redistribute embedded fonts. Use font names only and record safe fallbacks.",
    "",
    "Input:",
    "- PPTX: /mnt/presentation-template-source/source.pptx",
    `- Template id: ${args.templateId}`,
    `- Import id: ${args.importId}`,
    `- Source VAS version: ${args.sourceVersionId}`,
    `- Compiler version: ${PRESENTATION_TEMPLATE_COMPILER_VERSION}`,
    "",
    "Required process:",
    "1. Validate the OOXML package and inspect themes, dimensions, colors, fonts, and reusable master-level brand artwork. Do not extract or preserve source slide layouts, geometry, or placeholders.",
    "2. Use LibreOffice headless to render every visible slide to PDF, then pdftoppm to render PNG previews.",
    "3. Infer design tokens and author an AGENT_RUNBOOK.md that tells a future agent how to create new vm0-native HTML presentation slides in this visual language without copying source content or source layouts.",
    "4. Create /tmp/presentation-template-package with exactly these required paths: AGENT_RUNBOOK.md, template-manifest.json, design-tokens.json, provenance.json, renderer/README.md, assets/, qa/previews/.",
    "5. Put rendered PNGs in qa/previews/slide-1.png, qa/previews/slide-2.png, and so on. Include at least slide-1.png. These previews are review-only and are removed from the runtime template package.",
    "6. template-manifest.json must be strict JSON containing: importId, templateId, sourceVersionId, slideCount, aspectRatio, fonts (string array), fontFallbacks (object), colors (string array), excludedContent (string array), packageFiles (string array), metadata (object).",
    "7. provenance.json must include the template id, import id, source version, compiler version, and a statement that source content and notes were excluded.",
    `8. In /tmp/presentation-template-package create .vm0/storage.yaml with name: ${args.packageStorageName} and type: volume, then run zero volume push from that directory.`,
    "9. Verify the push succeeds. End with a concise success message that includes no extracted customer content.",
  ].join("\n");
}

function validatePptx(buffer: Buffer): ImportValidationError | null {
  if (buffer.length > MAX_PPTX_BYTES) {
    return { code: "too_large", message: "The PowerPoint file exceeds 100 MB" };
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    return { code: "invalid_pptx", message: "The file is not a valid PPTX" };
  }

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    return {
      code: "invalid_pptx",
      message: "The PowerPoint archive contains too many files",
    };
  }
  const totalUncompressed = entries.reduce((sum, entry) => {
    return sum + entry.header.size;
  }, 0);
  if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
    return {
      code: "invalid_pptx",
      message: "The expanded PowerPoint archive is too large",
    };
  }

  const names = new Set(
    entries.map((entry) => {
      return entry.entryName;
    }),
  );
  if (
    !names.has("[Content_Types].xml") ||
    !names.has("ppt/presentation.xml") ||
    ![...names].some((name) => {
      return /^ppt\/slides\/slide\d+\.xml$/.test(name);
    })
  ) {
    return {
      code: "invalid_pptx",
      message: "The PowerPoint file is missing required presentation data",
    };
  }
  if (names.has("EncryptedPackage") || names.has("EncryptionInfo")) {
    return {
      code: "encrypted_pptx",
      message: "Encrypted PowerPoint files are not supported",
    };
  }
  if (
    [...names].some((name) => {
      const lower = name.toLowerCase();
      return (
        lower.includes("vbaproject.bin") || lower.startsWith("ppt/embeddings/")
      );
    })
  ) {
    return {
      code: "unsupported_embedded_object",
      message: "Macros and embedded executable objects are not supported",
    };
  }

  const hasExternalRelationship = entries.some((entry) => {
    if (!entry.entryName.endsWith(".rels")) {
      return false;
    }
    if (entry.header.size > MAX_RELATIONSHIP_BYTES) {
      return true;
    }
    return /TargetMode\s*=\s*["']External["']/i.test(
      entry.getData().toString("utf8"),
    );
  });
  if (hasExternalRelationship) {
    return {
      code: "unsupported_embedded_object",
      message:
        "PowerPoint files with external linked content are not supported",
    };
  }
  return null;
}

async function featureEnabled(
  db: Parameters<typeof loadUserFeatureSwitchContext>[0],
  auth: TemplateAuth,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(
    FeatureSwitchKey.PresentationCustomTemplates,
    context,
  );
}

function manageable(ownerUserId: string, auth: TemplateAuth): boolean {
  return ownerUserId === auth.userId || auth.orgRole === "admin";
}

async function markImportFailed(
  db: Db,
  importId: string,
  error:
    | ImportValidationError
    | { readonly code: string; readonly message: string },
): Promise<void> {
  const timestamp = nowDate();
  await db
    .update(presentationTemplateImports)
    .set({
      status: "failed",
      errorCode: error.code,
      errorMessage: error.message,
      completedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(presentationTemplateImports.id, importId),
        inArray(presentationTemplateImports.status, [
          "uploading",
          "queued",
          "processing",
        ]),
      ),
    );
}

const startCompilerRun$ = command(
  async (
    { set },
    args: {
      readonly auth: TemplateAuth;
      readonly templateId: string;
      readonly importId: string;
      readonly sourceVersionId: string;
      readonly sourceStorageName: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [org] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.auth.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!org?.defaultAgentId) {
      await markImportFailed(db, args.importId, {
        code: "compile_failed",
        message:
          "A workspace default agent is required to analyze this template",
      });
      signal.throwIfAborted();
      return;
    }

    const packageStorageName = getPresentationTemplatePackageStorageName(
      args.templateId,
    );
    const result = await set(
      createZeroIntegrationRun$,
      {
        userId: args.auth.userId,
        orgId: args.auth.orgId,
        agentId: org.defaultAgentId,
        prompt: compilerPrompt({
          templateId: args.templateId,
          importId: args.importId,
          sourceVersionId: args.sourceVersionId,
          packageStorageName,
        }),
        additionalVolumes: [
          {
            name: args.sourceStorageName,
            version: args.sourceVersionId,
            mountPath: "/mnt/presentation-template-source",
          },
        ],
        triggerSource: "web",
        callbacks: [
          {
            internalKind: "presentation-template",
            secret: randomBytes(32).toString("base64url"),
            payload: {
              importId: args.importId,
              templateId: args.templateId,
            },
          },
        ],
        apiStartTime: now(),
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201 || result.body.status === "failed") {
      await markImportFailed(db, args.importId, {
        code: "compile_failed",
        message: "Template analysis could not be started",
      });
      signal.throwIfAborted();
      return;
    }

    const timestamp = nowDate();
    const [processing] = await db
      .update(presentationTemplateImports)
      .set({
        status: "processing",
        compilerVersion: PRESENTATION_TEMPLATE_COMPILER_VERSION,
        compileRunId: result.body.runId,
        processingStartedAt: timestamp,
        updatedAt: timestamp,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      })
      .where(
        and(
          eq(presentationTemplateImports.id, args.importId),
          eq(presentationTemplateImports.status, "queued"),
        ),
      )
      .returning({ id: presentationTemplateImports.id });
    signal.throwIfAborted();
    if (!processing) {
      return;
    }
  },
);

export const preparePresentationTemplateImport$ = command(
  async (
    { get, set },
    args: {
      readonly auth: TemplateAuth;
      readonly templateId: string;
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    if (!(await featureEnabled(db, args.auth))) {
      return notFound("Presentation template imports are not enabled");
    }
    signal.throwIfAborted();
    const [template] = await db
      .select({ ownerUserId: presentationTemplates.ownerUserId })
      .from(presentationTemplates)
      .where(
        and(
          eq(presentationTemplates.id, args.templateId),
          eq(presentationTemplates.orgId, args.auth.orgId),
          isNull(presentationTemplates.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!template || !manageable(template.ownerUserId, args.auth)) {
      return notFound("Presentation template not found");
    }
    if (!args.filename.toLowerCase().endsWith(".pptx")) {
      return badRequestMessage("Only .pptx files are supported");
    }
    if (args.size > MAX_PPTX_BYTES) {
      return badRequestMessage("The PowerPoint file exceeds 100 MB");
    }

    const timestamp = nowDate();
    const uploadExpiredBefore = new Date(
      timestamp.getTime() - UPLOAD_TTL_SECONDS * 1000,
    );
    await db
      .update(presentationTemplateImports)
      .set({
        status: "failed",
        errorCode: "upload_expired",
        errorMessage: "The upload expired before it was completed",
        completedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(presentationTemplateImports.templateId, args.templateId),
          eq(presentationTemplateImports.status, "uploading"),
          lt(presentationTemplateImports.createdAt, uploadExpiredBefore),
        ),
      );
    signal.throwIfAborted();

    const [activeImport] = await db
      .select({ id: presentationTemplateImports.id })
      .from(presentationTemplateImports)
      .where(
        and(
          eq(presentationTemplateImports.templateId, args.templateId),
          inArray(presentationTemplateImports.status, [
            "uploading",
            "queued",
            "processing",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (activeImport) {
      return conflict("This template already has an upload in progress");
    }

    const [created] = await db
      .insert(presentationTemplateImports)
      .values({
        orgId: args.auth.orgId,
        templateId: args.templateId,
        sourceFilename: args.filename,
        createdBy: args.auth.userId,
      })
      .returning();
    signal.throwIfAborted();
    if (!created) {
      throw new Error("Failed to create presentation template import");
    }
    signal.throwIfAborted();
    const [stillLive] = await db
      .select({ id: presentationTemplates.id })
      .from(presentationTemplates)
      .where(
        and(
          eq(presentationTemplates.id, args.templateId),
          isNull(presentationTemplates.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!stillLive) {
      await markImportFailed(db, created.id, {
        code: "template_deleted",
        message: "Template was deleted before the upload started",
      });
      signal.throwIfAborted();
      return notFound("Presentation template not found");
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const key = `${uploadPrefix({
      orgId: args.auth.orgId,
      templateId: args.templateId,
      importId: created.id,
    })}source.pptx`;
    const uploadUrl = await get(
      generatePresignedPutUrl(
        bucket,
        key,
        args.contentType,
        UPLOAD_TTL_SECONDS,
      ),
    );
    signal.throwIfAborted();

    return { status: 200 as const, import: created, uploadUrl };
  },
);

const commitUploadedPptx$ = command(
  async (
    { get, set },
    args: {
      readonly auth: TemplateAuth;
      readonly templateId: string;
      readonly importId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const prefix = uploadPrefix({
      orgId: args.auth.orgId,
      templateId: args.templateId,
      importId: args.importId,
    });
    const objects = await get(listS3Objects(bucket, prefix));
    signal.throwIfAborted();
    const objectKeys = objects.map((object) => {
      return object.key;
    });
    const sourceObject = objects.find((object) => {
      return object.key === `${prefix}source.pptx`;
    });
    if (!sourceObject) {
      return notFound("Uploaded PowerPoint file not found");
    }
    if (sourceObject.size > MAX_PPTX_BYTES) {
      await markImportFailed(db, args.importId, {
        code: "too_large",
        message: "The PowerPoint file exceeds 100 MB",
      });
      signal.throwIfAborted();
      await get(deleteS3Objects(bucket, objectKeys));
      signal.throwIfAborted();
      return badRequestMessage("The PowerPoint file exceeds 100 MB");
    }

    const sourceBuffer = await get(
      downloadS3BufferWithMaxBytes(bucket, sourceObject.key, MAX_PPTX_BYTES),
    );
    signal.throwIfAborted();
    const validation = safeSync(() => {
      return validatePptx(sourceBuffer);
    });
    const validationError =
      "error" in validation
        ? {
            code: "invalid_pptx" as const,
            message: "The file is not a valid PPTX",
          }
        : validation.ok;
    if (validationError) {
      await markImportFailed(db, args.importId, validationError);
      signal.throwIfAborted();
      await get(deleteS3Objects(bucket, objectKeys));
      signal.throwIfAborted();
      return badRequestMessage(validationError.message);
    }

    const sourceStorageName = getPresentationTemplateSourceStorageName(
      args.templateId,
    );
    const uploaded = await set(
      uploadVolumeServerSide$,
      {
        orgId: args.auth.orgId,
        storageName: sourceStorageName,
        files: [{ path: "source.pptx", content: sourceBuffer }],
      },
      signal,
    );
    signal.throwIfAborted();
    await get(deleteS3Objects(bucket, objectKeys));
    signal.throwIfAborted();

    const timestamp = nowDate();
    const [queued] = await db
      .update(presentationTemplateImports)
      .set({
        status: "queued",
        sourceStorageVersionId: uploaded.versionId,
        uploadCommittedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(presentationTemplateImports.id, args.importId),
          eq(presentationTemplateImports.status, "uploading"),
          sql`EXISTS (SELECT 1 FROM ${presentationTemplates} WHERE ${presentationTemplates.id} = ${args.templateId} AND ${presentationTemplates.deletedAt} IS NULL)`,
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!queued) {
      return conflict("This presentation template import is no longer active");
    }

    const started = await settle(
      set(
        startCompilerRun$,
        {
          auth: args.auth,
          templateId: args.templateId,
          importId: args.importId,
          sourceVersionId: uploaded.versionId,
          sourceStorageName,
        },
        signal,
      ),
      signal,
    );
    if (!started.ok) {
      await markImportFailed(db, args.importId, {
        code: "compile_failed",
        message: "Template analysis could not be started",
      });
      signal.throwIfAborted();
    }
    return { status: 202 as const };
  },
);

export const commitPresentationTemplateImport$ = command(
  async (
    { set },
    args: {
      readonly auth: TemplateAuth;
      readonly templateId: string;
      readonly importId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        id: presentationTemplateImports.id,
        status: presentationTemplateImports.status,
        ownerUserId: presentationTemplates.ownerUserId,
      })
      .from(presentationTemplateImports)
      .innerJoin(
        presentationTemplates,
        eq(presentationTemplates.id, presentationTemplateImports.templateId),
      )
      .where(
        and(
          eq(presentationTemplateImports.id, args.importId),
          eq(presentationTemplateImports.templateId, args.templateId),
          eq(presentationTemplateImports.orgId, args.auth.orgId),
          isNull(presentationTemplates.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row || !manageable(row.ownerUserId, args.auth)) {
      return notFound("Presentation template import not found");
    }
    if (row.status !== "uploading") {
      return conflict(
        "This presentation template import was already committed",
      );
    }

    return await set(commitUploadedPptx$, args, signal);
  },
);

export const retryPresentationTemplateImport$ = command(
  async (
    { set },
    args: {
      readonly auth: TemplateAuth;
      readonly templateId: string;
      readonly importId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        id: presentationTemplateImports.id,
        status: presentationTemplateImports.status,
        sourceVersionId: presentationTemplateImports.sourceStorageVersionId,
        ownerUserId: presentationTemplates.ownerUserId,
      })
      .from(presentationTemplateImports)
      .innerJoin(
        presentationTemplates,
        eq(presentationTemplates.id, presentationTemplateImports.templateId),
      )
      .where(
        and(
          eq(presentationTemplateImports.id, args.importId),
          eq(presentationTemplateImports.templateId, args.templateId),
          eq(presentationTemplateImports.orgId, args.auth.orgId),
          isNull(presentationTemplates.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row || !manageable(row.ownerUserId, args.auth)) {
      return notFound("Presentation template import not found");
    }
    if (row.status !== "failed" || !row.sourceVersionId) {
      return conflict("Only a failed committed import can be retried");
    }

    const [queued] = await db
      .update(presentationTemplateImports)
      .set({
        status: "queued",
        updatedAt: nowDate(),
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      })
      .where(
        and(
          eq(presentationTemplateImports.id, row.id),
          eq(presentationTemplateImports.status, "failed"),
          sql`EXISTS (SELECT 1 FROM ${presentationTemplates} WHERE ${presentationTemplates.id} = ${args.templateId} AND ${presentationTemplates.deletedAt} IS NULL)`,
        ),
      )
      .returning({ id: presentationTemplateImports.id });
    signal.throwIfAborted();
    if (!queued) {
      return conflict("This presentation template import is already retrying");
    }
    const started = await settle(
      set(
        startCompilerRun$,
        {
          auth: args.auth,
          templateId: args.templateId,
          importId: row.id,
          sourceVersionId: row.sourceVersionId,
          sourceStorageName: getPresentationTemplateSourceStorageName(
            args.templateId,
          ),
        },
        signal,
      ),
      signal,
    );
    if (!started.ok) {
      await markImportFailed(db, row.id, {
        code: "compile_failed",
        message: "Template analysis could not be started",
      });
      signal.throwIfAborted();
    }
    return { status: 202 as const };
  },
);

export type PresentationTemplateRouteAuth = AuthContext & {
  readonly orgId: string;
  readonly orgRole: "admin" | "member";
};
