import { command } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  type CommitPresentationTemplateBody,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { eq } from "drizzle-orm";

import { conflict } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  resolveArtifactObject$,
  type ResolvedArtifactObject,
} from "./artifact-storage.service";
import {
  presentationTemplateIdForRequest,
  type PresentationTemplateRow,
} from "./presentation-template-data.service";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";
import { preflightPresentationTemplate$ } from "./presentation-template-preflight.service";

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
    { set },
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
    return { ok: true };
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

const recordResolvedPresentationTemplate$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly manifest: ResolvedPresentationTemplateManifest;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, args.manifest.templateId);
      signal.throwIfAborted();
      const [existing] = await tx
        .select()
        .from(presentationTemplates)
        .where(eq(presentationTemplates.id, args.manifest.templateId))
        .limit(1);
      signal.throwIfAborted();

      // A resubmitted request id resolves to this same row, so the only
      // conflict worth reporting is one that names different uploads.
      if (existing) {
        if (
          existing.orgId !== args.orgId ||
          existing.ownerUserId !== args.ownerUserId ||
          !matchesManifest(existing, args.manifest)
        ) {
          return conflict(
            "This presentation template request was already committed with different uploads",
          );
        }
        return {
          status: 200 as const,
          body: { id: existing.id, status: existing.status },
        };
      }

      const currentTime = nowDate();
      const [created] = await tx
        .insert(presentationTemplates)
        .values({
          id: args.manifest.templateId,
          orgId: args.orgId,
          ownerUserId: args.ownerUserId,
          title: titleFromFilename(args.manifest.source.filename),
          status: "pending",
          sourceStorageKey: args.manifest.source.key,
          sourceFilename: args.manifest.source.filename,
          pageKeys: args.manifest.pages.map((page) => {
            return page.key;
          }),
          createdBy: args.ownerUserId,
          updatedBy: args.ownerUserId,
          createdAt: currentTime,
          updatedAt: currentTime,
        })
        .returning();
      if (!created) {
        throw new Error("Failed to create presentation template import");
      }
      return {
        status: 200 as const,
        body: { id: created.id, status: created.status },
      };
    });
  },
);

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
    return await set(
      recordResolvedPresentationTemplate$,
      {
        orgId: args.orgId,
        ownerUserId: args.ownerUserId,
        manifest: resolved.manifest,
      },
      signal,
    );
  },
);
