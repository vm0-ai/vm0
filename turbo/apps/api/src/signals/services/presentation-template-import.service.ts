import { command } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PAGES,
  MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES,
  type CreatePresentationTemplateImportBody,
  type PresentationTemplateUploadBody,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { presentationTemplateUploads } from "@okouai/db/schema/presentation-template-upload";
import { and, asc, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { generatePresignedPutUrl, s3MetadataHeaders } from "../external/s3";
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
  tx: Tx,
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

      // The API picks the object, so the caller never names one.
      const artifact = await set(
        allocateArtifactObject$,
        { userId: args.ownerUserId, filename: args.body.filename },
        signal,
      );
      signal.throwIfAborted();

      const pageIndex = args.body.role === "page" ? args.body.pageIndex : null;
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
      return { kind: "allocated" as const, artifact };
    });
    signal.throwIfAborted();

    if (slot.kind === "not-found") {
      return importNotFound(args.templateId);
    }
    if (slot.kind === "closed") {
      return conflict("This presentation template import is already committed");
    }

    const uploadUrl = await get(
      generatePresignedPutUrl(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        slot.artifact.key,
        args.body.contentType,
        PUT_URL_TTL_SECONDS,
        { usePublicEndpoint: true, metadata: slot.artifact.metadata },
      ),
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        uploadUrl,
        uploadHeaders: s3MetadataHeaders(slot.artifact.metadata),
      },
    };
  },
);

interface CollectedUploads {
  readonly sourceKey: string;
  readonly sourceSize: number;
  readonly pageKeys: readonly string[];
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
  const totalPageBytes = pages.reduce((total, row) => {
    return total + row.sizeBytes;
  }, 0);
  if (totalPageBytes > MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES) {
    return {
      error: `Page images must total ${MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES.toString()} bytes or fewer`,
    };
  }
  return {
    sourceKey: source.storageKey,
    sourceSize: source.sizeBytes,
    pageKeys: pages.map((row) => {
      return row.storageKey;
    }),
  };
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
      const rows = await tx
        .select()
        .from(presentationTemplateUploads)
        .where(eq(presentationTemplateUploads.templateId, args.templateId))
        .orderBy(asc(presentationTemplateUploads.pageIndex));
      return { kind: "open" as const, uploads: collectUploads(rows) };
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

    // The browser rendered these pages from a deck it opened, so the archive is
    // not re-validated. Reading the slide count is the one check on whether it
    // exported every page.
    const counted = await set(
      countPresentationTemplateSlides$,
      {
        bucket: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        key: uploads.sourceKey,
        size: uploads.sourceSize,
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
