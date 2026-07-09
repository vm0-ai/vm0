import { command } from "ccstate";
import { z } from "zod";
import type {
  NotionMemoryBackfillRequest,
  NotionMemoryStatusResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import { connectors } from "@vm0/db/schema/connector";
import {
  relationshipBackfillJobs,
  type RelationshipBackfillJobStatus,
} from "@vm0/db/schema/relationship-memory";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import { recordNotionBackfillPageMemorySource } from "./notion-memory-source.service";
import {
  NOTION_API_BASE,
  NOTION_VERSION,
  notionTitleFromProperties,
  pageIsUsable,
  resolveNotionAccess,
} from "./notion-workflow-event.service";

const log = logger("api:notion-memory-backfill");
const NOTION_BACKFILL_PAGE_SIZE = 50;
const BACKFILL_LOCK_STALE_MS = 5 * 60 * 1000;
const MAX_BACKFILL_JOBS_PER_DRAIN = 1;

type NotionMemoryBackfillStatus = RelationshipBackfillJobStatus | "idle";

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

type NotionMemoryMutationResult =
  | { readonly kind: "ok"; readonly status: NotionMemoryStatusResponse }
  | { readonly kind: "bad-request"; readonly message: string };

const notionPageParentSchema = z.union([
  z.object({ type: z.literal("page_id"), page_id: z.string().uuid() }),
  z.object({
    type: z.literal("data_source_id"),
    data_source_id: z.string().uuid(),
    database_id: z.string().uuid().optional(),
  }),
  z.object({ type: z.literal("database_id"), database_id: z.string().uuid() }),
  z.object({ type: z.literal("block_id"), block_id: z.string().uuid() }),
  z.object({ type: z.literal("workspace") }).passthrough(),
]);

const notionSearchPageSchema = z
  .object({
    object: z.literal("page"),
    id: z.string().uuid(),
    created_time: z.string().datetime().optional(),
    last_edited_time: z.string().datetime().optional(),
    archived: z.boolean().optional(),
    in_trash: z.boolean().optional(),
    url: z.string().url().optional(),
    parent: notionPageParentSchema,
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const notionSearchResponseSchema = z
  .object({
    results: z.array(notionSearchPageSchema).default([]),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean().default(false),
  })
  .passthrough();

const notionBackfillOptionsSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
  documentLimit: z.number().int().min(1).max(10_000),
});

type NotionSearchPage = z.infer<typeof notionSearchPageSchema>;

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function parseBackfillOptions(value: string): NotionMemoryBackfillRequest {
  return notionBackfillOptionsSchema.parse(JSON.parse(value) as unknown);
}

function parsedDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function loadNotionConnectorSummary(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<{
  readonly id: string;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
} | null> {
  const [connector] = await db
    .select({
      id: connectors.id,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, scope.orgId),
        eq(connectors.userId, scope.userId),
        eq(connectors.type, "notion"),
        eq(connectors.needsReconnect, false),
      ),
    )
    .limit(1);

  return connector
    ? {
        id: connector.id,
        workspaceId: connector.externalId ?? null,
        workspaceName: connector.externalUsername ?? null,
      }
    : null;
}

async function getNotionBackfillRow(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<{
  readonly status: NotionMemoryBackfillStatus;
  readonly estimatedTotal: number | null;
  readonly scannedCount: number;
  readonly recordedCount: number;
  readonly lastError: string | null;
  readonly updatedAt: Date | null;
  readonly completedAt: Date | null;
} | null> {
  const [backfill] = await db
    .select({
      status: relationshipBackfillJobs.status,
      estimatedTotal: relationshipBackfillJobs.estimatedTotal,
      scannedCount: relationshipBackfillJobs.scannedCount,
      recordedCount: relationshipBackfillJobs.enqueuedCount,
      lastError: relationshipBackfillJobs.lastError,
      updatedAt: relationshipBackfillJobs.updatedAt,
      completedAt: relationshipBackfillJobs.completedAt,
    })
    .from(relationshipBackfillJobs)
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, scope.orgId),
        eq(relationshipBackfillJobs.userId, scope.userId),
        eq(relationshipBackfillJobs.provider, "notion"),
      ),
    )
    .limit(1);
  return backfill ?? null;
}

export async function getNotionMemoryStatus(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<NotionMemoryStatusResponse> {
  const connector = await loadNotionConnectorSummary(db, scope);
  const backfill = await getNotionBackfillRow(db, scope);
  return {
    provider: "notion",
    connected: Boolean(connector),
    workspaceName: connector?.workspaceName ?? null,
    backfill: {
      status: backfill?.status ?? "idle",
      estimatedTotal: backfill?.estimatedTotal ?? null,
      scannedCount: backfill?.scannedCount ?? 0,
      recordedCount: backfill?.recordedCount ?? 0,
      lastError: backfill?.lastError ?? null,
      updatedAt: serializeDate(backfill?.updatedAt ?? null),
      completedAt: serializeDate(backfill?.completedAt ?? null),
    },
  };
}

async function upsertNotionBackfillJob(args: {
  readonly db: Db;
  readonly scope: MemoryScope;
  readonly connectorId: string;
  readonly options: NotionMemoryBackfillRequest;
}): Promise<void> {
  const currentTime = nowDate();
  await args.db
    .insert(relationshipBackfillJobs)
    .values({
      orgId: args.scope.orgId,
      userId: args.scope.userId,
      provider: "notion",
      connectorId: args.connectorId,
      status: "pending",
      query: JSON.stringify(args.options),
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipBackfillJobs.orgId,
        relationshipBackfillJobs.userId,
        relationshipBackfillJobs.provider,
      ],
      set: {
        connectorId: args.connectorId,
        status: "pending",
        query: JSON.stringify(args.options),
        nextPageToken: null,
        estimatedTotal: args.options.documentLimit,
        scannedCount: 0,
        enqueuedCount: 0,
        lockedAt: null,
        lastRunAt: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        updatedAt: currentTime,
      },
    });
}

export async function restartNotionMemoryBackfill(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly options: NotionMemoryBackfillRequest;
  readonly signal: AbortSignal;
}): Promise<NotionMemoryMutationResult> {
  const access = await resolveNotionAccess({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (access.kind !== "ok") {
    return { kind: "bad-request", message: access.message };
  }

  await upsertNotionBackfillJob({
    db: args.db,
    scope: { orgId: args.orgId, userId: args.userId },
    connectorId: access.access.connectorId,
    options: args.options,
  });
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    status: await getNotionMemoryStatus(args.db, {
      orgId: args.orgId,
      userId: args.userId,
    }),
  };
}

export async function stopNotionMemoryBackfill(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<NotionMemoryMutationResult> {
  const scope = { orgId: args.orgId, userId: args.userId };
  await args.db
    .update(relationshipBackfillJobs)
    .set({
      status: "stopped",
      lockedAt: null,
      lastError: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, scope.orgId),
        eq(relationshipBackfillJobs.userId, scope.userId),
        eq(relationshipBackfillJobs.provider, "notion"),
        inArray(relationshipBackfillJobs.status, ["pending", "running"]),
      ),
    );
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    status: await getNotionMemoryStatus(args.db, scope),
  };
}

async function searchNotionPages(args: {
  readonly accessToken: string;
  readonly cursor: string | null;
  readonly pageSize: number;
  readonly signal: AbortSignal;
}) {
  const response = await fetch(`${NOTION_API_BASE}/search`, {
    method: "POST",
    signal: args.signal,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: args.pageSize,
      ...(args.cursor ? { start_cursor: args.cursor } : {}),
    }),
  });
  args.signal.throwIfAborted();
  if (!response.ok) {
    throw new Error("Failed to search Notion pages for memory backfill");
  }

  return notionSearchResponseSchema.parse(await response.json());
}

function pageIsInBackfillWindow(page: NotionSearchPage, since: Date): boolean {
  const lastEditedAt = parsedDate(page.last_edited_time);
  return Boolean(lastEditedAt && lastEditedAt.getTime() >= since.getTime());
}

async function markNotionBackfillDone(
  db: Db,
  job: typeof relationshipBackfillJobs.$inferSelect,
): Promise<void> {
  const currentTime = nowDate();
  await db
    .update(relationshipBackfillJobs)
    .set({
      status: "done",
      nextPageToken: null,
      lockedAt: null,
      lastRunAt: currentTime,
      completedAt: currentTime,
      lastError: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(relationshipBackfillJobs.id, job.id),
        eq(relationshipBackfillJobs.status, "running"),
      ),
    );
}

async function scanNotionBackfillPages(args: {
  readonly db: Db;
  readonly job: typeof relationshipBackfillJobs.$inferSelect;
  readonly pages: readonly NotionSearchPage[];
  readonly connectorId: string;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly since: Date;
  readonly signal: AbortSignal;
}): Promise<{
  readonly scanned: number;
  readonly recorded: number;
  readonly reachedTimeBoundary: boolean;
}> {
  let recorded = 0;
  let scanned = 0;
  let reachedTimeBoundary = false;

  for (const page of args.pages) {
    args.signal.throwIfAborted();
    if (!pageIsUsable(page)) {
      continue;
    }
    if (!pageIsInBackfillWindow(page, args.since)) {
      reachedTimeBoundary = true;
      break;
    }

    scanned += 1;
    const didRecord = await recordNotionBackfillPageMemorySource({
      db: args.db,
      orgId: args.job.orgId,
      userId: args.job.userId,
      connectorId: args.connectorId,
      page: {
        id: page.id,
        title: notionTitleFromProperties(page.properties),
        url: page.url ?? null,
        createdTime: page.created_time ?? null,
        lastEditedTime: page.last_edited_time ?? null,
      },
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      reason: "notion_backfill",
    });
    if (didRecord) {
      recorded += 1;
    }
  }

  return { scanned, recorded, reachedTimeBoundary };
}

async function updateNotionBackfillProgress(args: {
  readonly db: Db;
  readonly job: typeof relationshipBackfillJobs.$inferSelect;
  readonly scanned: number;
  readonly recorded: number;
  readonly completed: boolean;
  readonly nextCursor: string | null;
  readonly documentLimit: number;
}): Promise<void> {
  const currentTime = nowDate();
  await args.db
    .update(relationshipBackfillJobs)
    .set({
      status: args.completed ? "done" : "pending",
      nextPageToken: args.completed ? null : args.nextCursor,
      estimatedTotal: args.documentLimit,
      scannedCount: sql`${relationshipBackfillJobs.scannedCount} + ${args.scanned}`,
      enqueuedCount: sql`${relationshipBackfillJobs.enqueuedCount} + ${args.recorded}`,
      lockedAt: null,
      lastRunAt: currentTime,
      completedAt: args.completed ? currentTime : null,
      lastError: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(relationshipBackfillJobs.id, args.job.id),
        eq(relationshipBackfillJobs.status, "running"),
      ),
    );
}

async function processNotionBackfillJob(
  db: Db,
  job: typeof relationshipBackfillJobs.$inferSelect,
  signal: AbortSignal,
): Promise<{ readonly scanned: number; readonly recorded: number }> {
  const options = parseBackfillOptions(job.query);
  const remaining = Math.max(0, options.documentLimit - job.scannedCount);
  if (remaining === 0) {
    await markNotionBackfillDone(db, job);
    return { scanned: 0, recorded: 0 };
  }

  const access = await resolveNotionAccess({
    db,
    orgId: job.orgId,
    userId: job.userId,
    connectorId: job.connectorId ?? undefined,
    signal,
  });
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    throw new Error(access.message);
  }

  const connector = await loadNotionConnectorSummary(db, {
    orgId: job.orgId,
    userId: job.userId,
  });
  const since = new Date(
    nowDate().getTime() - options.days * 24 * 60 * 60 * 1000,
  );
  const listed = await searchNotionPages({
    accessToken: access.access.accessToken,
    cursor: job.nextPageToken,
    pageSize: Math.min(NOTION_BACKFILL_PAGE_SIZE, remaining),
    signal,
  });
  signal.throwIfAborted();

  const scan = await scanNotionBackfillPages({
    db,
    job,
    pages: listed.results,
    connectorId: access.access.connectorId,
    workspaceId: connector?.workspaceId ?? null,
    workspaceName: connector?.workspaceName ?? null,
    since,
    signal,
  });

  const completed =
    scan.reachedTimeBoundary ||
    !listed.has_more ||
    job.scannedCount + scan.scanned >= options.documentLimit;
  await updateNotionBackfillProgress({
    db,
    job,
    scanned: scan.scanned,
    recorded: scan.recorded,
    completed,
    nextCursor: listed.next_cursor ?? null,
    documentLimit: options.documentLimit,
  });

  return { scanned: scan.scanned, recorded: scan.recorded };
}

async function markNotionBackfillFailed(args: {
  readonly db: Db;
  readonly job: typeof relationshipBackfillJobs.$inferSelect;
  readonly error: unknown;
}) {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  const retry = args.job.attempts + 1 < 3;
  await args.db
    .update(relationshipBackfillJobs)
    .set({
      status: retry ? "pending" : "failed",
      lockedAt: null,
      attempts: sql`${relationshipBackfillJobs.attempts} + 1`,
      lastError: message,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(relationshipBackfillJobs.id, args.job.id),
        eq(relationshipBackfillJobs.status, "running"),
      ),
    );
}

export const advanceNotionMemorySourceBackfillJobs$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const staleBefore = new Date(
      currentTime.getTime() - BACKFILL_LOCK_STALE_MS,
    );
    const jobs = await db
      .select()
      .from(relationshipBackfillJobs)
      .where(
        and(
          eq(relationshipBackfillJobs.provider, "notion"),
          inArray(relationshipBackfillJobs.status, ["pending", "running"]),
          or(
            isNull(relationshipBackfillJobs.lockedAt),
            lt(relationshipBackfillJobs.lockedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(relationshipBackfillJobs.updatedAt))
      .limit(MAX_BACKFILL_JOBS_PER_DRAIN);
    signal.throwIfAborted();

    let processed = 0;
    let failed = 0;
    let scanned = 0;
    let enqueued = 0;

    for (const job of jobs) {
      const [lockedJob] = await db
        .update(relationshipBackfillJobs)
        .set({
          status: "running",
          lockedAt: nowDate(),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(relationshipBackfillJobs.id, job.id),
            inArray(relationshipBackfillJobs.status, ["pending", "running"]),
            or(
              isNull(relationshipBackfillJobs.lockedAt),
              lt(relationshipBackfillJobs.lockedAt, staleBefore),
            ),
          ),
        )
        .returning();
      signal.throwIfAborted();
      if (!lockedJob) {
        continue;
      }

      const result = await settle(
        processNotionBackfillJob(db, lockedJob, signal),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok) {
        processed += 1;
        scanned += result.value.scanned;
        enqueued += result.value.recorded;
        continue;
      }

      failed += 1;
      log.warn("Notion memory source backfill failed", {
        jobId: lockedJob.id,
        error:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
      });
      await markNotionBackfillFailed({
        db,
        job: lockedJob,
        error: result.error,
      });
      signal.throwIfAborted();
    }

    return { processed, failed, scanned, enqueued };
  },
);
