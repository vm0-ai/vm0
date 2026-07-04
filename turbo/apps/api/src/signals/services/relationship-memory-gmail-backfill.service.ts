import { command } from "ccstate";
import { z } from "zod";
import type { GmailRelationshipBackfillRequest } from "@vm0/api-contracts/contracts/zero-relationships";
import {
  relationshipBackfillJobs,
  relationshipMemorySettings,
  relationshipSyncJobs,
  type RelationshipBackfillJobStatus,
} from "@vm0/db/schema/relationship-memory";
import { connectors } from "@vm0/db/schema/connector";
import { gmailWatchStates } from "@vm0/db/schema/gmail-event";
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../external/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import {
  ensureGmailWatchForUser,
  fetchGmailMessageContextById,
  resolveGmailAccess,
} from "./gmail-workflow-event.service";
import {
  enqueueGmailRelationshipRefreshJob,
  type GmailRelationshipMessageDirection,
} from "./relationship-memory-gmail-queue.service";

const log = logger("api:relationship-memory-gmail-backfill");
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_BACKFILL_PAGE_SIZE = 20;
const GMAIL_BACKFILL_SYNC_PRIORITY = 50;
const BACKFILL_LOCK_STALE_MS = 5 * 60 * 1000;
const MAX_BACKFILL_JOBS_PER_DRAIN = 1;
const gmailBackfillListSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string(),
        threadId: z.string().optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().nonnegative().optional(),
});

type GmailRelationshipBackfillStatus = RelationshipBackfillJobStatus | "idle";

interface RelationshipScope {
  readonly orgId: string;
  readonly userId: string;
}

interface GmailRelationshipBackfillProgress {
  readonly status: GmailRelationshipBackfillStatus;
  readonly estimatedTotal: number | null;
  readonly scannedCount: number;
  readonly enqueuedCount: number;
  readonly pendingSyncJobs: number;
  readonly lastError: string | null;
  readonly updatedAt: string | null;
  readonly completedAt: string | null;
}

interface GmailRelationshipStatus {
  readonly provider: "gmail";
  readonly connectorConnected: boolean;
  readonly enabled: boolean;
  readonly watchEnabled: boolean;
  readonly backfill: GmailRelationshipBackfillProgress;
}

type EnableGmailRelationshipResult =
  | { readonly kind: "ok"; readonly status: GmailRelationshipStatus }
  | { readonly kind: "bad-request"; readonly message: string };

function defaultGmailBackfillOptions(): GmailRelationshipBackfillRequest {
  return {
    days: 180,
    includeArchived: true,
    includeSent: true,
  };
}

function buildGmailBackfillQuery(
  options: GmailRelationshipBackfillRequest,
): string {
  return [
    options.includeArchived ? "in:anywhere" : "in:inbox",
    `newer_than:${options.days}d`,
    options.includeSent ? null : "-in:sent",
    "-in:drafts",
    "-in:trash",
    "-in:spam",
  ]
    .filter((part): part is string => {
      return part !== null;
    })
    .join(" ");
}

function relationshipDirectionFromLabels(
  labelIds: readonly string[],
): GmailRelationshipMessageDirection | null {
  const labels = new Set(labelIds);
  if (labels.has("DRAFT") || labels.has("TRASH") || labels.has("SPAM")) {
    return null;
  }
  return labels.has("SENT") ? "sent" : "received";
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function pendingSyncJobCount(
  db: ReadonlyDb,
  scope: RelationshipScope,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(relationshipSyncJobs)
    .where(
      and(
        eq(relationshipSyncJobs.orgId, scope.orgId),
        eq(relationshipSyncJobs.userId, scope.userId),
        eq(relationshipSyncJobs.provider, "gmail"),
        inArray(relationshipSyncJobs.status, ["pending", "running"]),
      ),
    );
  return row?.value ?? 0;
}

async function gmailWatchEnabled(
  db: ReadonlyDb,
  scope: RelationshipScope,
): Promise<boolean> {
  const [row] = await db
    .select({ id: gmailWatchStates.id })
    .from(gmailWatchStates)
    .where(
      and(
        eq(gmailWatchStates.orgId, scope.orgId),
        eq(gmailWatchStates.userId, scope.userId),
        eq(gmailWatchStates.needsRewatch, false),
        gt(gmailWatchStates.watchExpirationAt, nowDate()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function gmailConnectorConnected(
  db: ReadonlyDb,
  scope: RelationshipScope,
): Promise<boolean> {
  const [connector] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, scope.orgId),
        eq(connectors.userId, scope.userId),
        eq(connectors.type, "gmail"),
        eq(connectors.needsReconnect, false),
      ),
    )
    .limit(1);
  return Boolean(connector);
}

export async function getGmailRelationshipStatus(
  db: ReadonlyDb,
  scope: RelationshipScope,
): Promise<GmailRelationshipStatus> {
  const [setting] = await db
    .select({
      enabled: relationshipMemorySettings.enabled,
    })
    .from(relationshipMemorySettings)
    .where(
      and(
        eq(relationshipMemorySettings.orgId, scope.orgId),
        eq(relationshipMemorySettings.userId, scope.userId),
        eq(relationshipMemorySettings.provider, "gmail"),
      ),
    )
    .limit(1);

  const [backfill] = await db
    .select({
      status: relationshipBackfillJobs.status,
      estimatedTotal: relationshipBackfillJobs.estimatedTotal,
      scannedCount: relationshipBackfillJobs.scannedCount,
      enqueuedCount: relationshipBackfillJobs.enqueuedCount,
      lastError: relationshipBackfillJobs.lastError,
      updatedAt: relationshipBackfillJobs.updatedAt,
      completedAt: relationshipBackfillJobs.completedAt,
    })
    .from(relationshipBackfillJobs)
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, scope.orgId),
        eq(relationshipBackfillJobs.userId, scope.userId),
        eq(relationshipBackfillJobs.provider, "gmail"),
      ),
    )
    .limit(1);

  return {
    provider: "gmail",
    connectorConnected: await gmailConnectorConnected(db, scope),
    enabled: setting?.enabled ?? false,
    watchEnabled: await gmailWatchEnabled(db, scope),
    backfill: {
      status: backfill?.status ?? "idle",
      estimatedTotal: backfill?.estimatedTotal ?? null,
      scannedCount: backfill?.scannedCount ?? 0,
      enqueuedCount: backfill?.enqueuedCount ?? 0,
      pendingSyncJobs: await pendingSyncJobCount(db, scope),
      lastError: backfill?.lastError ?? null,
      updatedAt: serializeDate(backfill?.updatedAt ?? null),
      completedAt: serializeDate(backfill?.completedAt ?? null),
    },
  };
}

async function upsertEnabledSettings(
  db: Db,
  scope: RelationshipScope,
  bootstrapStatus: "pending" | "done",
) {
  const currentTime = nowDate();
  await db
    .insert(relationshipMemorySettings)
    .values({
      orgId: scope.orgId,
      userId: scope.userId,
      provider: "gmail",
      enabled: true,
      bootstrapStatus,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipMemorySettings.orgId,
        relationshipMemorySettings.userId,
        relationshipMemorySettings.provider,
      ],
      set: {
        enabled: true,
        bootstrapStatus,
        lastError: null,
        updatedAt: currentTime,
      },
    });
}

async function upsertBackfillJob(args: {
  readonly db: Db;
  readonly scope: RelationshipScope;
  readonly connectorId: string;
  readonly options: GmailRelationshipBackfillRequest;
  readonly restart: boolean;
}): Promise<"pending" | "done"> {
  const currentTime = nowDate();
  const query = buildGmailBackfillQuery(args.options);
  const [existing] = await args.db
    .select({
      status: relationshipBackfillJobs.status,
    })
    .from(relationshipBackfillJobs)
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, args.scope.orgId),
        eq(relationshipBackfillJobs.userId, args.scope.userId),
        eq(relationshipBackfillJobs.provider, "gmail"),
      ),
    )
    .limit(1);

  if (!existing) {
    await args.db.insert(relationshipBackfillJobs).values({
      orgId: args.scope.orgId,
      userId: args.scope.userId,
      provider: "gmail",
      connectorId: args.connectorId,
      status: "pending",
      query,
      createdAt: currentTime,
      updatedAt: currentTime,
    });
    return "pending";
  }

  if (existing.status === "done" && !args.restart) {
    await args.db
      .update(relationshipBackfillJobs)
      .set({
        connectorId: args.connectorId,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(relationshipBackfillJobs.orgId, args.scope.orgId),
          eq(relationshipBackfillJobs.userId, args.scope.userId),
          eq(relationshipBackfillJobs.provider, "gmail"),
        ),
      );
    return "done";
  }

  await args.db
    .update(relationshipBackfillJobs)
    .set({
      connectorId: args.connectorId,
      status: "pending",
      query,
      nextPageToken: null,
      estimatedTotal: null,
      scannedCount: 0,
      enqueuedCount: 0,
      lockedAt: null,
      lastRunAt: null,
      completedAt: null,
      attempts: 0,
      lastError: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, args.scope.orgId),
        eq(relationshipBackfillJobs.userId, args.scope.userId),
        eq(relationshipBackfillJobs.provider, "gmail"),
      ),
    );
  return "pending";
}

async function startGmailRelationshipBackfill(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly options: GmailRelationshipBackfillRequest;
  readonly restart: boolean;
  readonly signal: AbortSignal;
}): Promise<EnableGmailRelationshipResult> {
  const access = await resolveGmailAccess(args);
  args.signal.throwIfAborted();
  if (access.kind !== "ok") {
    return { kind: "bad-request", message: access.message };
  }

  const watch = await ensureGmailWatchForUser(args);
  args.signal.throwIfAborted();
  if (watch.kind !== "ok") {
    return { kind: "bad-request", message: watch.message };
  }

  const scope = { orgId: args.orgId, userId: args.userId };
  const backfillStatus = await upsertBackfillJob({
    db: args.db,
    scope,
    connectorId: access.access.connectorId,
    options: args.options,
    restart: args.restart,
  });
  args.signal.throwIfAborted();
  await upsertEnabledSettings(args.db, scope, backfillStatus);
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    status: await getGmailRelationshipStatus(args.db, scope),
  };
}

export async function enableGmailRelationshipMemory(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<EnableGmailRelationshipResult> {
  return await startGmailRelationshipBackfill({
    ...args,
    options: defaultGmailBackfillOptions(),
    restart: false,
  });
}

export async function restartGmailRelationshipBackfill(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly options: GmailRelationshipBackfillRequest;
  readonly signal: AbortSignal;
}): Promise<EnableGmailRelationshipResult> {
  return await startGmailRelationshipBackfill({
    ...args,
    restart: true,
  });
}

async function listBackfillMessages(args: {
  readonly accessToken: string;
  readonly query: string;
  readonly pageToken: string | null;
  readonly signal: AbortSignal;
}) {
  const url = new URL(`${GMAIL_API_BASE}/messages`);
  url.searchParams.set("q", args.query);
  url.searchParams.set("maxResults", String(GMAIL_BACKFILL_PAGE_SIZE));
  if (args.pageToken) {
    url.searchParams.set("pageToken", args.pageToken);
  }

  const response = await fetch(url, {
    method: "GET",
    signal: args.signal,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
  });
  args.signal.throwIfAborted();

  if (!response.ok) {
    throw new Error("Failed to list Gmail messages for relationship backfill");
  }
  return gmailBackfillListSchema.parse(await response.json());
}

async function processBackfillJob(
  db: Db,
  job: typeof relationshipBackfillJobs.$inferSelect,
  signal: AbortSignal,
): Promise<{ readonly scanned: number; readonly enqueued: number }> {
  const access = await resolveGmailAccess({
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

  const listed = await listBackfillMessages({
    accessToken: access.access.accessToken,
    query: job.query,
    pageToken: job.nextPageToken,
    signal,
  });
  signal.throwIfAborted();

  let enqueued = 0;
  const messages = listed.messages ?? [];
  for (const message of messages) {
    const context = await fetchGmailMessageContextById({
      accessToken: access.access.accessToken,
      messageId: message.id,
      threadId: message.threadId ?? null,
      labelIds: [],
      signal,
    });
    signal.throwIfAborted();
    const direction = context
      ? relationshipDirectionFromLabels(context.labelIds)
      : null;
    if (!context || !direction) {
      continue;
    }

    const didEnqueue = await enqueueGmailRelationshipRefreshJob(db, {
      orgId: job.orgId,
      userId: job.userId,
      connectorId: access.access.connectorId,
      priority: GMAIL_BACKFILL_SYNC_PRIORITY,
      reason: "gmail_backfill",
      message: {
        mailboxEmail: access.access.emailAddress ?? "me",
        historyId: `backfill:${job.id}`,
        messageId: context.messageId,
        threadId: context.threadId,
        direction,
        from: context.from,
        to: context.to,
        cc: context.cc,
        subject: context.subject,
        bodyText: context.bodyText,
      },
    });
    if (didEnqueue) {
      enqueued += 1;
    }
  }

  const completed = !listed.nextPageToken;
  const currentTime = nowDate();
  await db
    .update(relationshipBackfillJobs)
    .set({
      status: completed ? "done" : "pending",
      nextPageToken: listed.nextPageToken ?? null,
      estimatedTotal:
        listed.resultSizeEstimate ?? job.estimatedTotal ?? messages.length,
      scannedCount: sql`${relationshipBackfillJobs.scannedCount} + ${messages.length}`,
      enqueuedCount: sql`${relationshipBackfillJobs.enqueuedCount} + ${enqueued}`,
      lockedAt: null,
      lastRunAt: currentTime,
      completedAt: completed ? currentTime : null,
      lastError: null,
      updatedAt: currentTime,
    })
    .where(eq(relationshipBackfillJobs.id, job.id));
  signal.throwIfAborted();

  await db
    .insert(relationshipMemorySettings)
    .values({
      orgId: job.orgId,
      userId: job.userId,
      provider: "gmail",
      enabled: true,
      bootstrapStatus: completed ? "done" : "running",
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipMemorySettings.orgId,
        relationshipMemorySettings.userId,
        relationshipMemorySettings.provider,
      ],
      set: {
        enabled: true,
        bootstrapStatus: completed ? "done" : "running",
        lastError: null,
        updatedAt: currentTime,
      },
    });
  signal.throwIfAborted();

  return { scanned: messages.length, enqueued };
}

async function markBackfillFailed(args: {
  readonly db: Db;
  readonly job: typeof relationshipBackfillJobs.$inferSelect;
  readonly error: unknown;
}) {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  const retry = args.job.attempts + 1 < 3;
  const currentTime = nowDate();
  await args.db
    .update(relationshipBackfillJobs)
    .set({
      status: retry ? "pending" : "failed",
      lockedAt: null,
      attempts: sql`${relationshipBackfillJobs.attempts} + 1`,
      lastError: message,
      updatedAt: currentTime,
    })
    .where(eq(relationshipBackfillJobs.id, args.job.id));

  await args.db
    .update(relationshipMemorySettings)
    .set({
      bootstrapStatus: retry ? "pending" : "failed",
      lastError: message,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(relationshipMemorySettings.orgId, args.job.orgId),
        eq(relationshipMemorySettings.userId, args.job.userId),
        eq(relationshipMemorySettings.provider, "gmail"),
      ),
    );
}

export const advanceGmailRelationshipBackfillJobs$ = command(
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
          eq(relationshipBackfillJobs.provider, "gmail"),
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
        processBackfillJob(db, lockedJob, signal),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok) {
        processed += 1;
        scanned += result.value.scanned;
        enqueued += result.value.enqueued;
        continue;
      }

      failed += 1;
      log.warn("Gmail relationship backfill failed", {
        jobId: lockedJob.id,
        error:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
      });
      await markBackfillFailed({ db, job: lockedJob, error: result.error });
      signal.throwIfAborted();
    }

    return { processed, failed, scanned, enqueued };
  },
);
