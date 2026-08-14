import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  type PreparePresentationTemplateBody,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { conflict, badRequestMessage } from "../../lib/error";
import { env } from "../../lib/env";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { generatePresignedPutUrl, s3MetadataHeaders } from "../external/s3";
import { settle } from "../utils";
import {
  presentationTemplateIdForRequest,
  type PresentationTemplateRow,
} from "./presentation-template-data.service";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";
import {
  presentationTemplatePageFilename,
  presentationTemplatePageKey,
  presentationTemplatePageMetadata,
  presentationTemplateSourceKey,
  presentationTemplateSourceMetadata,
} from "./presentation-template-object.service";

const PRESIGNED_URL_TTL_SECONDS = 15 * 60;

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension || filename;
}

function isPptxFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pptx");
}

function arraysEqual(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      return value === right[index];
    })
  );
}

function matchesPreparation(
  row: PresentationTemplateRow,
  body: PreparePresentationTemplateBody,
): boolean {
  return (
    row.status === "pending" &&
    row.sourceFilename === body.filename &&
    row.sourceSizeBytes === body.sourceSize &&
    arraysEqual(row.pageSizesBytes, body.pageSizes)
  );
}

interface PreparePresentationTemplateArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly body: PreparePresentationTemplateBody;
}

type StorePreparationResult =
  | { readonly kind: "stored"; readonly row: PresentationTemplateRow }
  | { readonly kind: "conflict" };

async function storePreparationRow(
  tx: Tx,
  args: PreparePresentationTemplateArgs & {
    readonly templateId: string;
    readonly sourceKey: string;
    readonly pageKeys: readonly string[];
  },
  signal: AbortSignal,
): Promise<StorePreparationResult> {
  await lockPresentationTemplateLifecycle(tx, args.templateId);
  signal.throwIfAborted();
  const [existing] = await tx
    .select()
    .from(presentationTemplates)
    .where(eq(presentationTemplates.id, args.templateId))
    .limit(1);
  signal.throwIfAborted();
  if (existing) {
    return existing.orgId === args.orgId &&
      existing.ownerUserId === args.ownerUserId &&
      matchesPreparation(existing, args.body)
      ? { kind: "stored", row: existing }
      : { kind: "conflict" };
  }

  const currentTime = nowDate();
  const [inserted] = await tx
    .insert(presentationTemplates)
    .values({
      id: args.templateId,
      orgId: args.orgId,
      ownerUserId: args.ownerUserId,
      title: titleFromFilename(args.body.filename),
      sourceStorageKey: args.sourceKey,
      sourceFilename: args.body.filename,
      sourceSizeBytes: args.body.sourceSize,
      pageKeys: [...args.pageKeys],
      pageSizesBytes: args.body.pageSizes,
      createdBy: args.ownerUserId,
      updatedBy: args.ownerUserId,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .returning();
  if (!inserted) {
    throw new Error("Failed to prepare presentation template");
  }
  return { kind: "stored", row: inserted };
}

const preparePresentationTemplateUploadTargets$ = command(
  async (
    { get, set },
    args: {
      readonly templateId: string;
      readonly rowId: string;
      readonly body: PreparePresentationTemplateBody;
    },
    signal: AbortSignal,
  ) => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    return await set(writeDb$).transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, args.templateId);
      signal.throwIfAborted();
      const [row] = await tx
        .select()
        .from(presentationTemplates)
        .where(eq(presentationTemplates.id, args.rowId))
        .limit(1);
      if (!row || !matchesPreparation(row, args.body)) {
        return null;
      }
      const sourceMetadata = presentationTemplateSourceMetadata({
        templateId: row.id,
        ownerUserId: row.ownerUserId,
        size: row.sourceSizeBytes,
      });
      const sourceUploadUrl = await get(
        generatePresignedPutUrl(
          bucket,
          row.sourceStorageKey,
          PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
          PRESIGNED_URL_TTL_SECONDS,
          {
            usePublicEndpoint: true,
            metadata: sourceMetadata,
            immutable: true,
          },
        ),
      );
      const pages = await Promise.all(
        row.pageKeys.map(async (key, index) => {
          const size = row.pageSizesBytes[index];
          if (size === undefined) {
            throw new Error(
              "Presentation template page manifest is incomplete",
            );
          }
          const metadata = presentationTemplatePageMetadata({
            templateId: row.id,
            ownerUserId: row.ownerUserId,
            index,
            size,
          });
          return {
            index,
            filename: presentationTemplatePageFilename(index),
            uploadUrl: await get(
              generatePresignedPutUrl(
                bucket,
                key,
                PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
                PRESIGNED_URL_TTL_SECONDS,
                {
                  usePublicEndpoint: true,
                  metadata,
                  immutable: true,
                },
              ),
            ),
            uploadHeaders: {
              "content-type": PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
              "if-none-match": "*",
              ...s3MetadataHeaders(metadata),
            },
          };
        }),
      );
      return {
        templateId: row.id,
        source: {
          uploadUrl: sourceUploadUrl,
          uploadHeaders: {
            "content-type": PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
            "if-none-match": "*",
            ...s3MetadataHeaders(sourceMetadata),
          },
        },
        pages,
      };
    });
  },
);

export const preparePresentationTemplate$ = command(
  async (
    { set },
    args: PreparePresentationTemplateArgs,
    signal: AbortSignal,
  ) => {
    if (!isPptxFilename(args.body.filename)) {
      return badRequestMessage("Only .pptx presentation files are supported");
    }

    const templateId = presentationTemplateIdForRequest({
      orgId: args.orgId,
      ownerUserId: args.ownerUserId,
      requestId: args.body.requestId,
    });
    const uploadId = randomUUID();
    const sourceKey = presentationTemplateSourceKey(templateId, uploadId);
    const pageKeys = args.body.pageSizes.map((_size, index) => {
      return presentationTemplatePageKey(templateId, uploadId, index);
    });
    const db = set(writeDb$);
    const stored = await settle(
      db.transaction(async (tx) => {
        return await storePreparationRow(
          tx,
          { ...args, templateId, sourceKey, pageKeys },
          signal,
        );
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!stored.ok) {
      if (isUniqueViolation(stored.error)) {
        return conflict(
          "A presentation template import is already in progress",
        );
      }
      throw stored.error;
    }
    if (stored.value.kind === "conflict") {
      return conflict(
        "The preparation request does not match its existing ingestion",
      );
    }
    const prepared = await set(
      preparePresentationTemplateUploadTargets$,
      { templateId, rowId: stored.value.row.id, body: args.body },
      signal,
    );
    signal.throwIfAborted();
    if (!prepared) {
      return conflict(
        "The presentation template ingestion is no longer pending",
      );
    }
    return {
      status: 200 as const,
      body: prepared,
    };
  },
);
