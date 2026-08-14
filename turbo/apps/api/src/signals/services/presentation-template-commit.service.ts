import { command } from "ccstate";
import {
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq } from "drizzle-orm";

import { templateImportPrompt } from "../../lib/template-import-prompt";
import type { Tx } from "../../lib/db-types";
import { conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  downloadS3BufferRange,
  listS3ObjectsUnderPrefix,
  s3ObjectHead,
  type S3ObjectHead,
} from "../external/s3";
import { createAgentRun$ } from "./agent-run-create.service";
import {
  loadOwnedPresentationTemplate,
  loadPresentationTemplateAnalysisRunStatus,
  presentationTemplateAnalysisRunId,
  type PresentationTemplateRow,
} from "./presentation-template-data.service";
import { failPresentationTemplateImport$ } from "./presentation-template-failure.service";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";
import {
  hasExpectedPresentationTemplateMetadata,
  presentationTemplatePageMetadata,
  presentationTemplatePagePrefix,
  presentationTemplateSourceMetadata,
  presentationTemplateUploadIdFromManifest,
} from "./presentation-template-object.service";
import { preflightPresentationTemplate$ } from "./presentation-template-preflight.service";

const PNG_HEADER_BYTES = 24;
const OBJECT_VALIDATION_CONCURRENCY = 8;

type VerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_file"
        | "invalid_upload"
        | "page_count_mismatch"
        | "unsupported_format"
        | "encrypted_file"
        | "too_large";
      readonly message: string;
    };
type VerificationFailure = Exclude<VerificationResult, { readonly ok: true }>;
type VerifiedObjectSet = { readonly ok: true; readonly bucket: string };

function verificationFailure(
  code: VerificationFailure["code"],
  message: string,
): VerificationFailure {
  return { ok: false, code, message };
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<U>,
): Promise<readonly U[]> {
  const results: U[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined) {
          throw new Error("Presentation template validation index is invalid");
        }
        results[index] = await operation(item, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function matchesObjectHead(
  head: S3ObjectHead,
  args: {
    readonly contentType: string;
    readonly size: number;
    readonly metadata: Readonly<Record<string, string>>;
  },
): boolean {
  return (
    head.kind === "found" &&
    head.contentType === args.contentType &&
    head.contentLength === args.size &&
    hasExpectedPresentationTemplateMetadata(head.metadata, args.metadata)
  );
}

function isFixedWidePng(header: Buffer): boolean {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (
    header.length < PNG_HEADER_BYTES ||
    !header.subarray(0, signature.length).equals(signature) ||
    header.readUInt32BE(8) !== 13 ||
    header.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return false;
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  return width > 0 && height > 0 && width * 9 === height * 16;
}

const verifyPresentationTemplateObjectSet$ = command(
  async (
    { get },
    row: PresentationTemplateRow,
    signal: AbortSignal,
  ): Promise<VerificationFailure | VerifiedObjectSet> => {
    const uploadId = presentationTemplateUploadIdFromManifest({
      templateId: row.id,
      sourceKey: row.sourceStorageKey,
      pageKeys: row.pageKeys,
    });
    if (
      uploadId === null ||
      row.pageKeys.length === 0 ||
      row.pageKeys.length !== row.pageSizesBytes.length
    ) {
      return verificationFailure(
        "invalid_upload",
        "The prepared upload manifest is invalid",
      );
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const listedPages = await get(
      listS3ObjectsUnderPrefix(
        bucket,
        presentationTemplatePagePrefix(row.id, uploadId),
      ),
    );
    signal.throwIfAborted();
    const listedKeys = new Set(
      listedPages.map((object) => {
        return object.key;
      }),
    );
    if (
      listedKeys.size !== row.pageKeys.length ||
      row.pageKeys.some((key) => {
        return !listedKeys.has(key);
      })
    ) {
      return verificationFailure(
        "page_count_mismatch",
        "Every prepared page image must be uploaded exactly once",
      );
    }

    const sourceHead = await get(s3ObjectHead(bucket, row.sourceStorageKey));
    signal.throwIfAborted();
    if (
      !matchesObjectHead(sourceHead, {
        contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
        size: row.sourceSizeBytes,
        metadata: presentationTemplateSourceMetadata({
          templateId: row.id,
          ownerUserId: row.ownerUserId,
          size: row.sourceSizeBytes,
        }),
      })
    ) {
      return verificationFailure(
        "invalid_upload",
        "The source PPTX upload is missing or does not match its preparation",
      );
    }

    const pageHeads = await mapWithConcurrency(
      row.pageKeys,
      OBJECT_VALIDATION_CONCURRENCY,
      async (key) => {
        return await get(s3ObjectHead(bucket, key));
      },
    );
    signal.throwIfAborted();
    const invalidPageHead = pageHeads.findIndex((head, index) => {
      const size = row.pageSizesBytes[index];
      return (
        size === undefined ||
        !matchesObjectHead(head, {
          contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
          size,
          metadata: presentationTemplatePageMetadata({
            templateId: row.id,
            ownerUserId: row.ownerUserId,
            index,
            size,
          }),
        })
      );
    });
    if (invalidPageHead !== -1) {
      return verificationFailure(
        "invalid_upload",
        `Page ${(invalidPageHead + 1).toString()} is missing or does not match its preparation`,
      );
    }

    return { ok: true, bucket };
  },
);

const verifyPresentationTemplateContents$ = command(
  async (
    { get, set },
    args: {
      readonly row: PresentationTemplateRow;
      readonly bucket: string;
    },
    signal: AbortSignal,
  ): Promise<VerificationResult> => {
    const { row, bucket } = args;

    const preflight = await set(
      preflightPresentationTemplate$,
      {
        key: row.sourceStorageKey,
        filename: row.sourceFilename,
        contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
        size: row.sourceSizeBytes,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!preflight.ok) {
      return preflight;
    }
    if (preflight.slideCount !== row.pageKeys.length) {
      return verificationFailure(
        "page_count_mismatch",
        `The PPTX contains ${preflight.slideCount.toString()} slides but ${row.pageKeys.length.toString()} page images were prepared`,
      );
    }

    const pageHeaders = await mapWithConcurrency(
      row.pageKeys,
      OBJECT_VALIDATION_CONCURRENCY,
      async (key) => {
        return await get(
          downloadS3BufferRange(bucket, key, 0, PNG_HEADER_BYTES - 1, signal),
        );
      },
    );
    signal.throwIfAborted();
    const invalidPngIndex = pageHeaders.findIndex((header) => {
      return !isFixedWidePng(header);
    });
    return invalidPngIndex === -1
      ? { ok: true }
      : verificationFailure(
          "invalid_upload",
          `Page ${(invalidPngIndex + 1).toString()} is not a valid 16:9 PNG`,
        );
  },
);

const verifyPresentationTemplateUpload$ = command(
  async (
    { set },
    row: PresentationTemplateRow,
    signal: AbortSignal,
  ): Promise<VerificationResult> => {
    const objects = await set(
      verifyPresentationTemplateObjectSet$,
      row,
      signal,
    );
    if (!objects.ok) {
      return objects;
    }
    return await set(
      verifyPresentationTemplateContents$,
      { row, bucket: objects.bucket },
      signal,
    );
  },
);

function verificationError(result: Exclude<VerificationResult, { ok: true }>) {
  return {
    status: 400 as const,
    body: { error: { code: result.code, message: result.message } },
  };
}

function isFailedRunStatus(status: string): boolean {
  return status === "failed" || status === "timeout" || status === "cancelled";
}

interface CommitPresentationTemplateArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly templateId: string;
}

async function reconcileExistingAnalysisRun(
  tx: Tx,
  current: PresentationTemplateRow,
  args: CommitPresentationTemplateArgs,
  runStatus: string,
): Promise<{
  readonly status: 200;
  readonly body: {
    readonly id: string;
    readonly status: PresentationTemplateRow["status"];
  };
}> {
  if (current.status !== "pending") {
    return {
      status: 200,
      body: { id: current.id, status: current.status },
    };
  }
  const failed = isFailedRunStatus(runStatus);
  const [updated] = await tx
    .update(presentationTemplates)
    .set({
      status: failed ? "failed" : "processing",
      error: failed
        ? {
            code: "analysis_failed",
            message: "Template analysis failed before processing began",
          }
        : null,
      updatedAt: nowDate(),
      updatedBy: args.ownerUserId,
    })
    .where(eq(presentationTemplates.id, current.id))
    .returning({ status: presentationTemplates.status });
  return {
    status: 200,
    body: { id: current.id, status: updated?.status ?? current.status },
  };
}

const launchPresentationTemplateAnalysis$ = command(
  async (
    { set },
    args: CommitPresentationTemplateArgs & { readonly defaultAgentId: string },
    signal: AbortSignal,
  ) => {
    return await set(
      createAgentRun$,
      {
        userId: args.ownerUserId,
        orgId: args.orgId,
        runId: presentationTemplateAnalysisRunId(args.templateId),
        body: {
          agentComposeId: args.defaultAgentId,
          prompt: templateImportPrompt(args.templateId),
          triggerSource: "template-import",
          vars: {
            PRESENTATION_TEMPLATE_ID: args.templateId,
            OKOU_AGENT_ID: args.defaultAgentId,
          },
        },
        apiStartTime: now(),
        callbacks: [
          {
            internalKind: "presentation-template:import",
            payload: { templateId: args.templateId },
          },
        ],
        includeZeroTokenSecret: true,
        extraEnvironment: {
          OKOU_APP_URL: env("APP_URL"),
          OKOU_AGENT_ID: args.defaultAgentId,
        },
        connectorScope: {
          allowedConnectorSlugs: [],
          allowedCustomConnectorIds: [],
          source: "explicit",
        },
        validateEnvironmentReferences: false,
        queueOnConcurrencyLimit: true,
        enforceVm0Credits: true,
      },
      signal,
    );
  },
);

async function persistLaunchedAnalysisStatus(
  tx: Tx,
  current: PresentationTemplateRow,
  args: {
    readonly ownerUserId: string;
    readonly runStatus: string;
    readonly runError: string | undefined;
  },
) {
  const [afterCallback] = await tx
    .select()
    .from(presentationTemplates)
    .where(eq(presentationTemplates.id, current.id))
    .limit(1);
  if (!afterCallback) {
    return notFound(`Presentation template not found: ${current.id}`);
  }
  if (afterCallback.status !== "pending") {
    return {
      status: 200 as const,
      body: { id: afterCallback.id, status: afterCallback.status },
    };
  }

  const failed = isFailedRunStatus(args.runStatus);
  const [updated] = await tx
    .update(presentationTemplates)
    .set({
      status: failed ? "failed" : "processing",
      error: failed
        ? {
            code: "analysis_failed",
            message: args.runError ?? "Template analysis failed",
          }
        : null,
      updatedAt: nowDate(),
      updatedBy: args.ownerUserId,
    })
    .where(eq(presentationTemplates.id, current.id))
    .returning({ status: presentationTemplates.status });
  if (!updated) {
    throw new Error("Failed to commit presentation template ingestion");
  }
  return {
    status: 200 as const,
    body: { id: current.id, status: updated.status },
  };
}

export const commitPresentationTemplate$ = command(
  async (
    { set },
    args: CommitPresentationTemplateArgs,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const initial = await loadOwnedPresentationTemplate(db, args);
    signal.throwIfAborted();
    if (!initial) {
      return notFound(`Presentation template not found: ${args.templateId}`);
    }
    if (initial.status === "pending") {
      const verification = await set(
        verifyPresentationTemplateUpload$,
        initial,
        signal,
      );
      signal.throwIfAborted();
      if (!verification.ok) {
        return verificationError(verification);
      }
    }

    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    const response = await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, args.templateId);
      signal.throwIfAborted();
      const [current] = await tx
        .select()
        .from(presentationTemplates)
        .where(
          and(
            eq(presentationTemplates.id, args.templateId),
            eq(presentationTemplates.orgId, args.orgId),
            eq(presentationTemplates.ownerUserId, args.ownerUserId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!current) {
        return notFound(`Presentation template not found: ${args.templateId}`);
      }

      const existingRunStatus = await loadPresentationTemplateAnalysisRunStatus(
        tx,
        args,
      );
      signal.throwIfAborted();
      if (existingRunStatus) {
        return await reconcileExistingAnalysisRun(
          tx,
          current,
          args,
          existingRunStatus,
        );
      }
      if (current.status !== "pending") {
        return conflict(
          `Presentation template import is already ${current.status}`,
        );
      }
      if (!metadata?.defaultAgentId) {
        return conflict(
          "A default agent must be configured before importing a template",
        );
      }

      const runResult = await set(
        launchPresentationTemplateAnalysis$,
        { ...args, defaultAgentId: metadata.defaultAgentId },
        signal,
      );
      if (runResult.status !== 201) {
        return runResult;
      }
      return await persistLaunchedAnalysisStatus(tx, current, {
        ownerUserId: args.ownerUserId,
        runStatus: runResult.body.status,
        runError: runResult.body.error,
      });
    });
    signal.throwIfAborted();

    if (response.status === 200 && response.body.status === "failed") {
      await set(
        failPresentationTemplateImport$,
        {
          orgId: args.orgId,
          ownerUserId: args.ownerUserId,
          templateId: args.templateId,
          error: {
            code: "analysis_failed",
            message: "Template analysis failed before processing began",
          },
        },
        signal,
      );
    }
    return response;
  },
);
