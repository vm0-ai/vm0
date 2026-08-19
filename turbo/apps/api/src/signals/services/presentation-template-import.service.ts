import { command } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PAGES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES,
  type CreatePresentationTemplateImportBody,
  type PresentationTemplateUploadBody,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { presentationTemplateUploads } from "@okouai/db/schema/presentation-template-upload";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type ReadonlyDb } from "../external/db";
import {
  deleteS3Objects,
  generatePresignedPutUrl,
  s3MetadataHeaders,
  s3ObjectHead,
  type S3ObjectHead,
} from "../external/s3";
import { allocateArtifactObject$ } from "./artifact-storage.service";
import { presentationTemplateIdForRequest } from "./presentation-template-data.service";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";
import { countPresentationTemplateSlides$ } from "./presentation-template-slide-count.service";

const PUT_URL_TTL_SECONDS = 3600;

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index === -1 ? "" : filename.slice(index).toLowerCase();
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/u, "").trim();
  return withoutExtension || filename;
}

function badRequest(message: string) {
  return {
    status: 400 as const,
    body: { error: { code: "BAD_REQUEST", message } },
  };
}

function importNotFound(templateId: string) {
  return notFound(`Presentation template import not found: ${templateId}`);
}

/**
 * An import is open while it is still collecting uploads. Commit freezes the
 * ordered result onto the template row, so a template that already carries a
 * source key is closed.
 */
function isOpenImport(row: {
  readonly status: string;
  readonly sourceStorageKey: string | null;
}): boolean {
  return row.status === "pending" && row.sourceStorageKey === null;
}

export const createPresentationTemplateImport$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly body: CreatePresentationTemplateImportBody;
    },
    signal: AbortSignal,
  ) => {
    if (extensionOf(args.body.sourceFilename) !== ".pptx") {
      return badRequest("Only .pptx presentation files are supported");
    }
    const templateId = presentationTemplateIdForRequest({
      orgId: args.orgId,
      ownerUserId: args.ownerUserId,
      requestId: args.body.requestId,
    });

    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, templateId);
      signal.throwIfAborted();
      const [existing] = await tx
        .select()
        .from(presentationTemplates)
        .where(eq(presentationTemplates.id, templateId))
        .limit(1);
      signal.throwIfAborted();

      // Repeating the request id resolves to the same import rather than
      // opening a second one.
      if (existing) {
        return {
          status: 200 as const,
          body: { id: existing.id, status: existing.status },
        };
      }

      const currentTime = nowDate();
      const [created] = await tx
        .insert(presentationTemplates)
        .values({
          id: templateId,
          orgId: args.orgId,
          ownerUserId: args.ownerUserId,
          title: titleFromFilename(args.body.sourceFilename),
          status: "pending",
          sourceStorageKey: null,
          sourceFilename: args.body.sourceFilename,
          createdBy: args.ownerUserId,
          updatedBy: args.ownerUserId,
          createdAt: currentTime,
          updatedAt: currentTime,
        })
        .returning();
      if (!created) {
        throw new Error("Failed to open presentation template import");
      }
      return {
        status: 200 as const,
        body: { id: created.id, status: created.status },
      };
    });
  },
);

async function loadOpenImport(
  tx: Tx | ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly templateId: string;
  },
) {
  const [row] = await tx
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
  return row ?? null;
}

export const requestPresentationTemplateUpload$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
      readonly body: PresentationTemplateUploadBody;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // Reject an unknown or already-committed import before doing any storage
    // work. The transaction below repeats this check under the lifecycle lock,
    // which is the authoritative one; this read only keeps an S3 round trip off
    // a request that cannot succeed.
    const opening = await loadOpenImport(db, args);
    signal.throwIfAborted();
    if (!opening) {
      return importNotFound(args.templateId);
    }
    if (!isOpenImport(opening)) {
      return conflict("This presentation template import is already committed");
    }

    // The API picks the object, so the caller never names one. Allocating only
    // chooses a key and writes nothing, so it runs before the transaction opens
    // rather than holding a pooled connection and the lifecycle lock across an
    // S3 round trip.
    const artifact = await set(
      allocateArtifactObject$,
      { userId: args.ownerUserId, filename: args.body.filename },
      signal,
    );
    signal.throwIfAborted();

    const slot = await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, args.templateId);
      signal.throwIfAborted();
      const template = await loadOpenImport(tx, args);
      signal.throwIfAborted();
      if (!template) {
        return { kind: "not-found" as const };
      }
      if (!isOpenImport(template)) {
        return { kind: "closed" as const };
      }

      const pageIndex = args.body.role === "page" ? args.body.pageIndex : null;
      // Re-requesting a slot replaces its object, so the previous one has to be
      // read before the upsert overwrites the key and then deleted.
      const [previous] = await tx
        .select({ storageKey: presentationTemplateUploads.storageKey })
        .from(presentationTemplateUploads)
        .where(
          and(
            eq(presentationTemplateUploads.templateId, args.templateId),
            eq(presentationTemplateUploads.role, args.body.role),
            pageIndex === null
              ? isNull(presentationTemplateUploads.pageIndex)
              : eq(presentationTemplateUploads.pageIndex, pageIndex),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      await tx
        .insert(presentationTemplateUploads)
        .values({
          templateId: args.templateId,
          role: args.body.role,
          pageIndex,
          storageKey: artifact.key,
          filename: args.body.filename,
          contentType: args.body.contentType,
          sizeBytes: args.body.size,
        })
        .onConflictDoUpdate({
          target:
            args.body.role === "source"
              ? [presentationTemplateUploads.templateId]
              : [
                  presentationTemplateUploads.templateId,
                  presentationTemplateUploads.pageIndex,
                ],
          targetWhere: eq(presentationTemplateUploads.role, args.body.role),
          set: {
            storageKey: artifact.key,
            filename: args.body.filename,
            contentType: args.body.contentType,
            sizeBytes: args.body.size,
          },
        });
      return {
        kind: "allocated" as const,
        replacedKey: previous?.storageKey,
      };
    });
    signal.throwIfAborted();

    if (slot.kind === "not-found") {
      return importNotFound(args.templateId);
    }
    if (slot.kind === "closed") {
      return conflict("This presentation template import is already committed");
    }

    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    if (slot.replacedKey && slot.replacedKey !== artifact.key) {
      await get(deleteS3Objects(bucket, [slot.replacedKey]));
      signal.throwIfAborted();
    }

    const uploadUrl = await get(
      generatePresignedPutUrl(
        bucket,
        artifact.key,
        args.body.contentType,
        PUT_URL_TTL_SECONDS,
        { usePublicEndpoint: true, metadata: artifact.metadata },
      ),
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        uploadUrl,
        uploadHeaders: s3MetadataHeaders(artifact.metadata),
      },
    };
  },
);

interface CollectedUploads {
  readonly sourceKey: string;
  readonly pageKeys: readonly string[];
}

/** A slot may be allocated and then abandoned, so commit measures the bytes. */
interface StoredUploads {
  readonly sourceSize: number;
  readonly totalPageBytes: number;
}

function collectUploads(
  rows: readonly (typeof presentationTemplateUploads.$inferSelect)[],
): CollectedUploads | { readonly error: string } {
  const source = rows.find((row) => {
    return row.role === "source";
  });
  if (!source) {
    return { error: "The source deck has not been uploaded" };
  }
  const pages = rows.filter((row) => {
    return row.role === "page";
  });
  if (pages.length === 0) {
    return { error: "No page images have been uploaded" };
  }
  if (pages.length > MAX_PRESENTATION_TEMPLATE_PAGES) {
    return {
      error: `An import may contain at most ${MAX_PRESENTATION_TEMPLATE_PAGES.toString()} pages`,
    };
  }
  const missing = pages.findIndex((row, index) => {
    return row.pageIndex !== index;
  });
  if (missing !== -1) {
    return { error: `Page ${(missing + 1).toString()} is missing` };
  }
  return {
    sourceKey: source.storageKey,
    pageKeys: pages.map((row) => {
      return row.storageKey;
    }),
  };
}

/**
 * Bytes actually stored for one slot. A presigned PUT accepts an empty body, so
 * an object that is absent and one that is zero length say the same thing: the
 * upload never delivered the slot's content.
 */
function storedSize(head: S3ObjectHead): number {
  return head.kind === "found" ? (head.contentLength ?? 0) : 0;
}

/**
 * Allocating a slot only reserves an object; the caller still has to PUT the
 * bytes. Commit therefore measures every allocated object instead of trusting
 * the size the caller declared when it asked for the slot.
 */
const measureStoredUploads$ = command(
  async (
    { get },
    uploads: CollectedUploads,
    signal: AbortSignal,
  ): Promise<StoredUploads | { readonly error: string }> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const [sourceHead, pageHeads] = await Promise.all([
      get(s3ObjectHead(bucket, uploads.sourceKey)),
      Promise.all(
        uploads.pageKeys.map(async (key) => {
          return await get(s3ObjectHead(bucket, key));
        }),
      ),
    ]);
    signal.throwIfAborted();

    const sourceSize = storedSize(sourceHead);
    if (sourceSize === 0) {
      return { error: "The source deck was never uploaded" };
    }
    const pageSizes = pageHeads.map(storedSize);
    const emptyPage = pageSizes.findIndex((size) => {
      return size === 0;
    });
    if (emptyPage !== -1) {
      return {
        error: `Page ${(emptyPage + 1).toString()} was never uploaded`,
      };
    }

    if (sourceSize > MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES) {
      return {
        error: `Presentation files must be ${MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES.toString()} bytes or smaller`,
      };
    }
    const oversizedPage = pageSizes.findIndex((size) => {
      return size > MAX_PRESENTATION_TEMPLATE_PAGE_BYTES;
    });
    if (oversizedPage !== -1) {
      return {
        error: `Page ${(oversizedPage + 1).toString()} must be no larger than ${MAX_PRESENTATION_TEMPLATE_PAGE_BYTES.toString()} bytes`,
      };
    }
    const totalPageBytes = pageSizes.reduce((total, size) => {
      return total + size;
    }, 0);
    if (totalPageBytes > MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES) {
      return {
        error: `Page images must total ${MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES.toString()} bytes or fewer`,
      };
    }
    return { sourceSize, totalPageBytes };
  },
);

function sameUploads(left: CollectedUploads, right: CollectedUploads): boolean {
  return (
    left.sourceKey === right.sourceKey &&
    left.pageKeys.length === right.pageKeys.length &&
    left.pageKeys.every((key, index) => {
      return key === right.pageKeys[index];
    })
  );
}

async function collectImportUploads(
  tx: Tx,
  templateId: string,
): Promise<CollectedUploads | { readonly error: string }> {
  const rows = await tx
    .select()
    .from(presentationTemplateUploads)
    .where(eq(presentationTemplateUploads.templateId, templateId))
    .orderBy(asc(presentationTemplateUploads.pageIndex));
  return collectUploads(rows);
}

export const commitPresentationTemplateImport$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const collected = await db.transaction(async (tx) => {
      const template = await loadOpenImport(tx, args);
      signal.throwIfAborted();
      if (!template) {
        return { kind: "not-found" as const };
      }
      // Committing twice returns the committed template unchanged.
      if (!isOpenImport(template)) {
        return { kind: "committed" as const, template };
      }
      return {
        kind: "open" as const,
        uploads: await collectImportUploads(tx, args.templateId),
      };
    });
    signal.throwIfAborted();

    if (collected.kind === "not-found") {
      return importNotFound(args.templateId);
    }
    if (collected.kind === "committed") {
      return {
        status: 200 as const,
        body: {
          id: collected.template.id,
          status: collected.template.status,
        },
      };
    }
    if ("error" in collected.uploads) {
      return badRequest(collected.uploads.error);
    }
    const uploads = collected.uploads;

    const measured = await set(measureStoredUploads$, uploads, signal);
    signal.throwIfAborted();
    if ("error" in measured) {
      return badRequest(measured.error);
    }

    // The browser rendered these pages from a deck it opened, so the archive is
    // not re-validated. Reading the slide count is the one check on whether it
    // exported every page.
    const counted = await set(
      countPresentationTemplateSlides$,
      {
        bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        key: uploads.sourceKey,
        size: measured.sourceSize,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!counted.ok) {
      return badRequest(counted.message);
    }
    if (counted.slideCount !== uploads.pageKeys.length) {
      return badRequest(
        `The PPTX contains ${counted.slideCount.toString()} slides but ${uploads.pageKeys.length.toString()} page images were uploaded`,
      );
    }

    return await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, args.templateId);
      signal.throwIfAborted();
      const template = await loadOpenImport(tx, args);
      signal.throwIfAborted();
      if (!template) {
        return importNotFound(args.templateId);
      }
      if (!isOpenImport(template)) {
        return {
          status: 200 as const,
          body: { id: template.id, status: template.status },
        };
      }
      // A slot allocated while the bytes above were being measured would make
      // the measured set stale, so freeze only the set that was verified.
      const current = await collectImportUploads(tx, args.templateId);
      signal.throwIfAborted();
      if ("error" in current || !sameUploads(current, uploads)) {
        return conflict(
          "The import changed while it was being committed; commit it again",
        );
      }
      const [committed] = await tx
        .update(presentationTemplates)
        .set({
          sourceStorageKey: uploads.sourceKey,
          pageKeys: [...uploads.pageKeys],
          updatedAt: nowDate(),
          updatedBy: args.ownerUserId,
        })
        .where(eq(presentationTemplates.id, args.templateId))
        .returning();
      if (!committed) {
        throw new Error("Failed to commit presentation template import");
      }
      // Staging rows have served their purpose once the ordered set is frozen.
      await tx
        .delete(presentationTemplateUploads)
        .where(eq(presentationTemplateUploads.templateId, args.templateId));
      return {
        status: 200 as const,
        body: { id: committed.id, status: committed.status },
      };
    });
  },
);
