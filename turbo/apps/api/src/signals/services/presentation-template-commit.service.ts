import { command } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  type CommitPresentationTemplateBody,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq } from "drizzle-orm";

import { templateImportPrompt } from "../../lib/template-import-prompt";
import type { Tx } from "../../lib/db-types";
import { conflict } from "../../lib/error";
import { env } from "../../lib/env";
import { isUniqueViolation } from "../../lib/pg-errors";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { downloadS3BufferRange } from "../external/s3";
import {
  createAgentRun$,
  type CreateRunErrorResult,
} from "./agent-run-create.service";
import {
  resolveArtifactObject$,
  type ResolvedArtifactObject,
} from "./artifact-storage.service";
import {
  loadPresentationTemplateAnalysisRunStatus,
  presentationTemplateAnalysisRunId,
  presentationTemplateIdForRequest,
  type PresentationTemplateRow,
} from "./presentation-template-data.service";
import { failPresentationTemplateImport$ } from "./presentation-template-failure.service";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";
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

interface ResolvedPresentationTemplateManifest {
  readonly templateId: string;
  readonly source: ResolvedArtifactObject;
  readonly pages: readonly ResolvedArtifactObject[];
}

class AnalysisLaunchRejected extends Error {
  constructor(readonly response: CreateRunErrorResult) {
    super("Presentation template analysis launch was rejected");
  }
}

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

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index === -1 ? "" : filename.slice(index).toLowerCase();
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension || filename;
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

const resolvePresentationTemplateManifest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly body: CommitPresentationTemplateBody;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly ok: true;
        readonly manifest: ResolvedPresentationTemplateManifest;
      }
    | VerificationFailure
  > => {
    const templateId = presentationTemplateIdForRequest({
      orgId: args.orgId,
      ownerUserId: args.ownerUserId,
      requestId: args.body.requestId,
    });
    const source = await set(
      resolveArtifactObject$,
      { userId: args.ownerUserId, id: args.body.sourceFileId },
      signal,
    );
    if (!source) {
      return verificationFailure(
        "invalid_upload",
        "The source PPTX upload was not found",
      );
    }

    const resolvedPages = await mapWithConcurrency(
      args.body.pageFileIds,
      OBJECT_VALIDATION_CONCURRENCY,
      async (id) => {
        return await set(
          resolveArtifactObject$,
          { userId: args.ownerUserId, id },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    const missingPageIndex = resolvedPages.findIndex((page) => {
      return page === null;
    });
    if (missingPageIndex !== -1) {
      return verificationFailure(
        "invalid_upload",
        `Page ${(missingPageIndex + 1).toString()} upload was not found`,
      );
    }
    const pages = resolvedPages.filter((page) => {
      return page !== null;
    });

    if (
      extensionOf(source.filename) !== ".pptx" ||
      source.contentType !== PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE
    ) {
      return verificationFailure(
        "unsupported_format",
        "Only .pptx presentation files are supported",
      );
    }
    if (source.size <= 0) {
      return verificationFailure(
        "invalid_file",
        "The uploaded presentation is empty",
      );
    }
    if (source.size > MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES) {
      return verificationFailure(
        "too_large",
        `Presentation files must be ${MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES.toString()} bytes or smaller`,
      );
    }

    const invalidPageIndex = pages.findIndex((page) => {
      return (
        page.contentType !== PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE ||
        page.size <= 0 ||
        page.size > MAX_PRESENTATION_TEMPLATE_PAGE_BYTES
      );
    });
    if (invalidPageIndex !== -1) {
      return verificationFailure(
        "invalid_upload",
        `Page ${(invalidPageIndex + 1).toString()} must be a non-empty PNG no larger than ${MAX_PRESENTATION_TEMPLATE_PAGE_BYTES.toString()} bytes`,
      );
    }
    const totalPageBytes = pages.reduce((total, page) => {
      return total + page.size;
    }, 0);
    if (totalPageBytes > MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES) {
      return verificationFailure(
        "too_large",
        `Page images must total ${MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES.toString()} bytes or fewer`,
      );
    }

    return {
      ok: true,
      manifest: { templateId, source, pages },
    };
  },
);

const verifyPresentationTemplateContents$ = command(
  async (
    { get, set },
    manifest: ResolvedPresentationTemplateManifest,
    signal: AbortSignal,
  ): Promise<VerificationResult> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const preflight = await set(
      preflightPresentationTemplate$,
      {
        bucket,
        key: manifest.source.key,
        filename: manifest.source.filename,
        contentType: manifest.source.contentType,
        size: manifest.source.size,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!preflight.ok) {
      return preflight;
    }
    if (preflight.slideCount !== manifest.pages.length) {
      return verificationFailure(
        "page_count_mismatch",
        `The PPTX contains ${preflight.slideCount.toString()} slides but ${manifest.pages.length.toString()} page images were committed`,
      );
    }

    const pageHeaders = await mapWithConcurrency(
      manifest.pages,
      OBJECT_VALIDATION_CONCURRENCY,
      async (page) => {
        return await get(
          downloadS3BufferRange(
            bucket,
            page.key,
            0,
            PNG_HEADER_BYTES - 1,
            signal,
          ),
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

function verificationError(result: VerificationFailure) {
  return {
    status: 400 as const,
    body: { error: { code: result.code, message: result.message } },
  };
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      return value === right[index];
    })
  );
}

function matchesManifest(
  row: PresentationTemplateRow,
  manifest: ResolvedPresentationTemplateManifest,
): boolean {
  return (
    row.sourceStorageKey === manifest.source.key &&
    row.sourceFilename === manifest.source.filename &&
    arraysEqual(
      row.pageKeys,
      manifest.pages.map((page) => {
        return page.key;
      }),
    )
  );
}

function isFailedRunStatus(status: string): boolean {
  return status === "failed" || status === "timeout" || status === "cancelled";
}

interface PresentationTemplateLifecycleArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly templateId: string;
}

async function reconcileExistingAnalysisRun(
  tx: Tx,
  current: PresentationTemplateRow,
  args: PresentationTemplateLifecycleArgs,
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
    args: PresentationTemplateLifecycleArgs & {
      readonly defaultAgentId: string;
    },
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
    throw new Error("Presentation template disappeared during commit");
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
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly body: CommitPresentationTemplateBody;
    },
    signal: AbortSignal,
  ) => {
    const resolved = await set(
      resolvePresentationTemplateManifest$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (!resolved.ok) {
      return verificationError(resolved);
    }
    const verification = await set(
      verifyPresentationTemplateContents$,
      resolved.manifest,
      signal,
    );
    signal.throwIfAborted();
    if (!verification.ok) {
      return verificationError(verification);
    }

    const db = set(writeDb$);
    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    const lifecycleArgs: PresentationTemplateLifecycleArgs = {
      orgId: args.orgId,
      ownerUserId: args.ownerUserId,
      templateId: resolved.manifest.templateId,
    };
    let response;
    try {
      response = await db.transaction(async (tx) => {
        await lockPresentationTemplateLifecycle(tx, lifecycleArgs.templateId);
        signal.throwIfAborted();
        const [existing] = await tx
          .select()
          .from(presentationTemplates)
          .where(eq(presentationTemplates.id, lifecycleArgs.templateId))
          .limit(1);
        signal.throwIfAborted();

        if (
          existing &&
          (existing.orgId !== args.orgId ||
            existing.ownerUserId !== args.ownerUserId ||
            !matchesManifest(existing, resolved.manifest))
        ) {
          return conflict(
            "This presentation template request was already committed with different uploads",
          );
        }

        if (!existing && !metadata?.defaultAgentId) {
          return conflict(
            "A default agent must be configured before importing a template",
          );
        }

        let current = existing;
        if (!current) {
          const currentTime = nowDate();
          [current] = await tx
            .insert(presentationTemplates)
            .values({
              id: lifecycleArgs.templateId,
              orgId: args.orgId,
              ownerUserId: args.ownerUserId,
              title: titleFromFilename(resolved.manifest.source.filename),
              status: "pending",
              sourceStorageKey: resolved.manifest.source.key,
              sourceFilename: resolved.manifest.source.filename,
              pageKeys: resolved.manifest.pages.map((page) => {
                return page.key;
              }),
              createdBy: args.ownerUserId,
              updatedBy: args.ownerUserId,
              createdAt: currentTime,
              updatedAt: currentTime,
            })
            .returning();
        }
        if (!current) {
          throw new Error("Failed to create presentation template import");
        }

        const existingRunStatus =
          await loadPresentationTemplateAnalysisRunStatus(tx, lifecycleArgs);
        signal.throwIfAborted();
        if (existingRunStatus) {
          return await reconcileExistingAnalysisRun(
            tx,
            current,
            lifecycleArgs,
            existingRunStatus,
          );
        }
        if (current.status !== "pending") {
          return {
            status: 200 as const,
            body: { id: current.id, status: current.status },
          };
        }
        if (!metadata?.defaultAgentId) {
          return conflict(
            "A default agent must be configured before importing a template",
          );
        }

        const runResult = await set(
          launchPresentationTemplateAnalysis$,
          { ...lifecycleArgs, defaultAgentId: metadata.defaultAgentId },
          signal,
        );
        if (runResult.status !== 201) {
          throw new AnalysisLaunchRejected(runResult);
        }
        return await persistLaunchedAnalysisStatus(tx, current, {
          ownerUserId: args.ownerUserId,
          runStatus: runResult.body.status,
          runError: runResult.body.error,
        });
      });
    } catch (error) {
      if (error instanceof AnalysisLaunchRejected) {
        return error.response;
      }
      if (isUniqueViolation(error)) {
        return conflict("A presentation template import is already active");
      }
      throw error;
    }
    signal.throwIfAborted();

    if (response.status === 200 && response.body.status === "failed") {
      await set(
        failPresentationTemplateImport$,
        {
          orgId: args.orgId,
          ownerUserId: args.ownerUserId,
          templateId: lifecycleArgs.templateId,
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
