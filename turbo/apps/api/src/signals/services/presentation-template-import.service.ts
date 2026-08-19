import { command } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PAGES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES,
  type CreatePresentationTemplateImportBody,
  type PresentationTemplateUploadBody,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { presentationTemplateImportThreads } from "@okouai/db/schema/presentation-template-import-thread";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { presentationTemplateUploads } from "@okouai/db/schema/presentation-template-upload";
import { zeroAgents } from "@okouai/db/schema/zero-agent";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { conflict, notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { templateImportPrompt } from "../../lib/template-import-prompt";
import { organizationAuthContext$ } from "../auth/auth-context";
import { publicBrand$ } from "../context/hono";
import { writeDb$, type ReadonlyDb } from "../external/db";
import {
  deleteS3Objects,
  generatePresignedPutUrl,
  s3MetadataHeaders,
  s3ObjectHead,
} from "../external/s3";
import { allocateArtifactObject$ } from "./artifact-storage.service";
import { sendNormalEvent$ } from "./chat-events.command";
import { createUserMessageDocument } from "./chat-user-message.service";
import { presentationTemplateIdForRequest } from "./presentation-template-data.service";
import { lockPresentationTemplateLifecycle } from "./presentation-template-lifecycle.service";
import { countPresentationTemplateSlides$ } from "./presentation-template-slide-count.service";
import { createAutomationChatThread } from "./workflow-user-automation-thread.service";

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
 * Commit has two halves that fail independently — freezing the ordered set, and
 * starting the analysis that reads it — so the template's own columns say which
 * half still has to run:
 *
 * - open: still collecting uploads (`pending`, no source key)
 * - frozen: the ordered set is committed but no analysis has started yet
 * - anything else: analysis has started and the import owns a chat thread
 *
 * A commit that is repeated after a crash therefore resumes at the right half
 * instead of redoing the whole thing or leaving the import stranded.
 */
function isOpenImport(row: {
  readonly status: string;
  readonly sourceStorageKey: string | null;
}): boolean {
  return row.status === "pending" && row.sourceStorageKey === null;
}

function isFrozenImport(row: {
  readonly status: string;
  readonly sourceStorageKey: string | null;
}): boolean {
  return row.status === "pending" && row.sourceStorageKey !== null;
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

      // The API picks the object, so the caller never names one.
      const artifact = await set(
        allocateArtifactObject$,
        { userId: args.ownerUserId, filename: args.body.filename },
        signal,
      );
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
        artifact,
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
    if (slot.replacedKey && slot.replacedKey !== slot.artifact.key) {
      await get(deleteS3Objects(bucket, [slot.replacedKey]));
      signal.throwIfAborted();
    }

    const uploadUrl = await get(
      generatePresignedPutUrl(
        bucket,
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
    const heads = await Promise.all(
      [uploads.sourceKey, ...uploads.pageKeys].map(async (key) => {
        return await get(s3ObjectHead(bucket, key));
      }),
    );
    signal.throwIfAborted();

    const missing = heads.findIndex((head) => {
      return head.kind !== "found" || head.contentLength === undefined;
    });
    if (missing === 0) {
      return { error: "The source deck was never uploaded" };
    }
    if (missing > 0) {
      return { error: `Page ${missing.toString()} was never uploaded` };
    }

    const sizes = heads.map((head) => {
      return head.kind === "found" ? (head.contentLength ?? 0) : 0;
    });
    const [sourceSize = 0, ...pageSizes] = sizes;
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

/**
 * Freezing the verified set is the point of no return for the uploads: the
 * ordered keys move onto the template row and the staging rows are dropped. The
 * import stays `pending` until analysis actually starts, so a commit that dies
 * here can be repeated.
 */
const freezeImport$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
      readonly uploads: CollectedUploads;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      await lockPresentationTemplateLifecycle(tx, args.templateId);
      signal.throwIfAborted();
      const template = await loadOpenImport(tx, args);
      signal.throwIfAborted();
      if (!template) {
        return { kind: "not-found" as const };
      }
      if (!isOpenImport(template)) {
        return { kind: "frozen" as const };
      }
      // A slot allocated while the bytes were being measured would make the
      // measured set stale, so freeze only the set that was verified.
      const current = await collectImportUploads(tx, args.templateId);
      signal.throwIfAborted();
      if ("error" in current || !sameUploads(current, args.uploads)) {
        return { kind: "changed" as const };
      }
      const [committed] = await tx
        .update(presentationTemplates)
        .set({
          sourceStorageKey: args.uploads.sourceKey,
          pageKeys: [...args.uploads.pageKeys],
          updatedAt: nowDate(),
          updatedBy: args.ownerUserId,
        })
        .where(eq(presentationTemplates.id, args.templateId))
        .returning({ id: presentationTemplates.id });
      if (!committed) {
        throw new Error("Failed to commit presentation template import");
      }
      // Staging rows have served their purpose once the set is frozen.
      await tx
        .delete(presentationTemplateUploads)
        .where(eq(presentationTemplateUploads.templateId, args.templateId));
      return { kind: "frozen" as const };
    });
  },
);

/**
 * Prove the collected set actually exists in storage and belongs to the
 * committed deck, then freeze it. Resolves to an error response, or to null
 * once the import is frozen and only its analysis is left to start.
 */
const freezeUploads$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
      readonly uploads: CollectedUploads | { readonly error: string };
    },
    signal: AbortSignal,
  ) => {
    if ("error" in args.uploads) {
      return badRequest(args.uploads.error);
    }
    const uploads = args.uploads;

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

    const frozen = await set(freezeImport$, { ...args, uploads }, signal);
    signal.throwIfAborted();
    if (frozen.kind === "not-found") {
      return importNotFound(args.templateId);
    }
    if (frozen.kind === "changed") {
      return conflict(
        "The import changed while it was being committed; commit it again",
      );
    }
    return null;
  },
);

interface AnalysisAgent {
  readonly id: string;
  readonly orgId: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
}

/** Analysis runs on the organization's default agent, like any other chat. */
async function loadDefaultAgent(
  tx: Tx,
  orgId: string,
): Promise<AnalysisAgent | null> {
  const [agent] = await tx
    .select({
      id: zeroAgents.id,
      orgId: zeroAgents.orgId,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(orgMetadata)
    .innerJoin(zeroAgents, eq(zeroAgents.id, orgMetadata.defaultAgentId))
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return agent ?? null;
}

/**
 * The thread is what authorizes the run to read the deck and pages back, so the
 * mapping is written together with the thread and before any message is sent.
 * The lifecycle lock is what keeps two concurrent commits from opening two.
 */
async function ensureImportThread(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly templateId: string;
    readonly agentId: string;
    readonly title: string;
    readonly currentTime: Date;
  },
): Promise<string> {
  await lockPresentationTemplateLifecycle(tx, args.templateId);
  const [existing] = await tx
    .select({ chatThreadId: presentationTemplateImportThreads.chatThreadId })
    .from(presentationTemplateImportThreads)
    .where(eq(presentationTemplateImportThreads.templateId, args.templateId))
    .limit(1);
  if (existing) {
    return existing.chatThreadId;
  }
  const chatThreadId = await createAutomationChatThread(tx, {
    userId: args.ownerUserId,
    orgId: args.orgId,
    agentId: args.agentId,
    title: args.title,
    currentTime: args.currentTime,
  });
  await tx
    .insert(presentationTemplateImportThreads)
    .values({ templateId: args.templateId, chatThreadId });
  return chatThreadId;
}

/**
 * Analysis is started the way the owner would start it: open a thread they can
 * watch, then send it a message. Nothing about this run is privileged — it
 * reaches the import only because the thread it runs in is mapped to it.
 */
const startImportAnalysis$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
      readonly title: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const started = await db.transaction(async (tx) => {
      const agent = await loadDefaultAgent(tx, args.orgId);
      if (!agent) {
        return { kind: "no-agent" as const };
      }
      return {
        kind: "thread" as const,
        agent,
        chatThreadId: await ensureImportThread(tx, {
          ...args,
          agentId: agent.id,
          currentTime,
        }),
      };
    });
    signal.throwIfAborted();
    if (started.kind === "no-agent") {
      return conflict(
        "This organization has no default agent to analyse the import with",
      );
    }

    const prompt = templateImportPrompt(args.templateId);
    const sent = await set(
      sendNormalEvent$,
      {
        auth: get(organizationAuthContext$),
        body: {
          agentId: started.agent.id,
          threadId: started.chatThreadId,
          prompt,
          userMessage: createUserMessageDocument({ text: prompt }),
          hasTextContent: true,
        },
        userId: args.ownerUserId,
        orgId: args.orgId,
        apiStartTime: currentTime.getTime(),
        publicBrand: get(publicBrand$),
        preloadedAgent: started.agent,
      },
      signal,
    );
    signal.throwIfAborted();
    if (sent.status !== 201) {
      return sent;
    }

    // Only a started analysis moves the import out of `pending`, so a commit
    // that failed to send is retried rather than reported as processing.
    const [processing] = await db
      .update(presentationTemplates)
      .set({
        status: "processing",
        updatedAt: nowDate(),
        updatedBy: args.ownerUserId,
      })
      .where(
        and(
          eq(presentationTemplates.id, args.templateId),
          eq(presentationTemplates.status, "pending"),
        ),
      )
      .returning({ status: presentationTemplates.status });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        id: args.templateId,
        status: processing?.status ?? "processing",
        chatThreadId: started.chatThreadId,
      },
    };
  },
);

/**
 * Report a committed import without restarting anything. The thread is part of
 * the answer because it is where the caller watches the analysis happen.
 */
async function committedImportResponse(
  db: ReadonlyDb,
  template: { readonly id: string; readonly status: string },
) {
  const [link] = await db
    .select({ chatThreadId: presentationTemplateImportThreads.chatThreadId })
    .from(presentationTemplateImportThreads)
    .where(eq(presentationTemplateImportThreads.templateId, template.id))
    .limit(1);
  return {
    status: 200 as const,
    body: {
      id: template.id,
      status: template.status,
      chatThreadId: link?.chatThreadId ?? null,
    },
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
      // A frozen import already owns its uploads; it only needs its analysis
      // started. Anything further along is reported as it stands.
      if (isFrozenImport(template)) {
        return { kind: "frozen" as const, template };
      }
      if (!isOpenImport(template)) {
        return { kind: "started" as const, template };
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
    if (collected.kind === "started") {
      return await committedImportResponse(db, collected.template);
    }
    if (collected.kind === "open") {
      const rejected = await set(
        freezeUploads$,
        { ...args, uploads: collected.uploads },
        signal,
      );
      signal.throwIfAborted();
      if (rejected) {
        return rejected;
      }
    }

    const [template] = await db
      .select({ title: presentationTemplates.title })
      .from(presentationTemplates)
      .where(eq(presentationTemplates.id, args.templateId))
      .limit(1);
    signal.throwIfAborted();
    if (!template) {
      return importNotFound(args.templateId);
    }
    return await set(
      startImportAnalysis$,
      { ...args, title: template.title },
      signal,
    );
  },
);
