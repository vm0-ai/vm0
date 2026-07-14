import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { FeatureSwitchKey } from "@vm0/core";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
} from "@vm0/db/schema/zero-workflow";
import { zeroWorkflowQueueEvents } from "@vm0/db/schema/zero-workflow-queue";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, ReadonlyDb } from "../external/db";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import {
  internalRunCallbackKinds,
  type InternalRunCallbackKind,
} from "./internal-run-callback";
import { hasUnclaimedQueuedUserMessage } from "./zero-chat-queued-message.service";

const WORKFLOW_QUEUE_EVENT_PARAMS_KEY = "__workflow_queue_event_params__";

const workflowQueueEventParamsWireSchema = z.object({
  version: z.literal(1),
  prompt: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
  callbacks: z
    .array(
      z.object({
        internalKind: z.enum(internalRunCallbackKinds),
        secret: z.string(),
        payload: z.unknown(),
      }),
    )
    .optional(),
  recordLastRunId: z.boolean().optional(),
  recordLastRunAt: z.boolean().optional(),
});

/**
 * The caller-supplied remainder of `RunWorkflowTriggerNowArgs` persisted with
 * a queued event. Fields the trigger-run command derives from the trigger row
 * itself (default prompt, default callbacks) stay undefined and are rebuilt
 * at dequeue time.
 */
interface WorkflowQueueEventParams {
  readonly version: 1;
  readonly prompt?: string;
  readonly appendSystemPrompt?: string;
  readonly callbacks?: readonly {
    readonly internalKind: InternalRunCallbackKind;
    readonly secret: string;
    readonly payload: unknown;
  }[];
  readonly recordLastRunId?: boolean;
  readonly recordLastRunAt?: boolean;
}

async function encryptWorkflowQueueEventParams(
  params: WorkflowQueueEventParams,
  ctx: { readonly userId: string; readonly orgId: string },
): Promise<string> {
  const encrypted = await encryptPersistentSecretsMap(
    { [WORKFLOW_QUEUE_EVENT_PARAMS_KEY]: JSON.stringify(params) },
    ctx,
  );
  if (!encrypted) {
    throw new Error("Failed to encrypt workflow queue event params");
  }
  return encrypted;
}

export async function decryptWorkflowQueueEventParams(
  encryptedParams: string,
  ctx: { readonly userId: string; readonly orgId: string },
): Promise<WorkflowQueueEventParams | null> {
  const decrypted = await decryptPersistentSecretsMap(encryptedParams, ctx);
  const raw = decrypted?.[WORKFLOW_QUEUE_EVENT_PARAMS_KEY];
  if (!raw) {
    return null;
  }
  return workflowQueueEventParamsWireSchema.parse(JSON.parse(raw));
}

export function workflowQueueEnabledForOwner(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly overrides: Record<string, boolean>;
}): boolean {
  return isFeatureEnabled(FeatureSwitchKey.WorkflowQueue, {
    userId: args.userId,
    orgId: args.orgId,
    overrides: args.overrides,
  });
}

function chatMessageQueueLock(chatThreadId: string) {
  const key = `chat_message_queue:${chatThreadId}`;
  return sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * The pre-cutover advisory lock. Taken alongside the thread lock while old
 * API versions (which serialize on this key against the legacy table) may
 * still be running. Remove with the legacy dual-read.
 */
function legacyWorkflowQueueLock(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}) {
  const key = `workflow_queue:${args.orgId}:${args.userId}:${args.workflowId}`;
  return sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

interface WorkflowThreadMapping {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly queuePausedAt: Date | null;
}

async function loadWorkflowThreadMapping(
  db: Db,
  chatThreadId: string,
): Promise<WorkflowThreadMapping | null> {
  const [row] = await db
    .select({
      orgId: workflowUserTriggerThreads.orgId,
      userId: workflowUserTriggerThreads.userId,
      workflowId: workflowUserTriggerThreads.workflowId,
      queuePausedAt: workflowUserTriggerThreads.queuePausedAt,
    })
    .from(workflowUserTriggerThreads)
    .where(eq(workflowUserTriggerThreads.chatThreadId, chatThreadId))
    .limit(1);
  return row ?? null;
}

/**
 * Pause is read from both homes while old API versions may still write the
 * legacy `workflow_user_trigger_threads` columns: paused when either side
 * says so. Collapses to the `chat_threads` columns once dual-write ends.
 */
async function queuePausedForThread(
  db: Db,
  chatThreadId: string,
  mapping: WorkflowThreadMapping | null,
): Promise<boolean> {
  if (mapping?.queuePausedAt) {
    return true;
  }
  const [thread] = await db
    .select({ queuePausedAt: chatThreads.queuePausedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return thread !== undefined && thread.queuePausedAt !== null;
}

/**
 * Thread-level busy check: any in-flight run bound to the workflow's chat
 * thread blocks the queue. `queued` counts — the workflow's single in-flight
 * run may itself be waiting on an org concurrency slot, and admitting more
 * runs would break the serial invariant.
 */
async function activeRunExistsForWorkflowThread(
  db: Db,
  threadId: string,
): Promise<boolean> {
  const [run] = await db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    )
    .limit(1);
  return run !== undefined;
}

async function pendingWorkflowEventExists(
  db: Db,
  chatThreadId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: chatMessageQueue.id })
    .from(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.chatThreadId, chatThreadId),
        eq(chatMessageQueue.itemType, "workflow_event"),
      ),
    )
    .limit(1);
  if (row) {
    return true;
  }
  const [legacy] = await db
    .select({ id: zeroWorkflowQueueEvents.id })
    .from(zeroWorkflowQueueEvents)
    .where(eq(zeroWorkflowQueueEvents.chatThreadId, chatThreadId))
    .limit(1);
  return legacy !== undefined;
}

async function pendingTickExistsForTrigger(
  db: Db,
  triggerId: string,
): Promise<boolean> {
  const [tick] = await db
    .select({ id: chatMessageQueue.id })
    .from(chatMessageQueue)
    .where(eq(chatMessageQueue.triggerId, triggerId))
    .limit(1);
  if (tick) {
    return true;
  }
  const [legacy] = await db
    .select({ id: zeroWorkflowQueueEvents.id })
    .from(zeroWorkflowQueueEvents)
    .where(eq(zeroWorkflowQueueEvents.triggerId, triggerId))
    .limit(1);
  return legacy !== undefined;
}

type WorkflowQueueAdmission = "proceed" | "enqueued";

/**
 * Decide whether a fired trigger event may create its run now or must wait in
 * the chat message queue. Serialized per chat thread via an advisory lock.
 * Schedule ticks coalesce per trigger: at most one pending tick.
 */
export async function admitWorkflowTriggerEvent(
  db: Db,
  args: {
    readonly trigger: typeof zeroWorkflowTriggers.$inferSelect;
    readonly chatThreadId: string;
    readonly triggerSource: TriggerSource;
    readonly triggerBrief: string | undefined;
    readonly params: WorkflowQueueEventParams;
  },
): Promise<WorkflowQueueAdmission> {
  const { trigger } = args;
  const encryptedParams = await encryptWorkflowQueueEventParams(args.params, {
    userId: trigger.ownerUserId,
    orgId: trigger.orgId,
  });

  return await db.transaction(async (tx) => {
    await tx.execute(chatMessageQueueLock(args.chatThreadId));
    await tx.execute(
      legacyWorkflowQueueLock({
        orgId: trigger.orgId,
        userId: trigger.ownerUserId,
        workflowId: trigger.workflowId,
      }),
    );

    const mapping = await loadWorkflowThreadMapping(tx, args.chatThreadId);
    const paused = await queuePausedForThread(tx, args.chatThreadId, mapping);

    if (!paused) {
      const busy = await activeRunExistsForWorkflowThread(
        tx,
        args.chatThreadId,
      );
      if (!busy && !(await pendingWorkflowEventExists(tx, args.chatThreadId))) {
        return "proceed";
      }
    }

    if (
      trigger.kind === "schedule" &&
      (await pendingTickExistsForTrigger(tx, trigger.id))
    ) {
      return "enqueued";
    }

    await tx.insert(chatMessageQueue).values({
      orgId: trigger.orgId,
      userId: trigger.ownerUserId,
      chatThreadId: args.chatThreadId,
      itemType: "workflow_event",
      triggerId: trigger.id,
      triggerSource: args.triggerSource,
      triggerBrief: args.triggerBrief ?? null,
      encryptedParams,
    });
    return "enqueued";
  });
}

export interface ClaimedWorkflowQueueEvent {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly triggerId: string;
  readonly chatThreadId: string;
  readonly triggerSource: string;
  readonly triggerBrief: string | null;
  readonly encryptedParams: string;
  readonly createdAt: Date;
  /** Which table the row was claimed from; restores go back to the same. */
  readonly source: "chat_message_queue" | "legacy";
  /** Legacy FIFO key remainder; null for chat_message_queue rows. */
  readonly workflowId: string | null;
}

async function claimLegacyWorkflowQueueEvent(
  tx: Db,
  mapping: WorkflowThreadMapping,
): Promise<ClaimedWorkflowQueueEvent | null> {
  const [event] = await tx
    .select()
    .from(zeroWorkflowQueueEvents)
    .where(
      and(
        eq(zeroWorkflowQueueEvents.orgId, mapping.orgId),
        eq(zeroWorkflowQueueEvents.userId, mapping.userId),
        eq(zeroWorkflowQueueEvents.workflowId, mapping.workflowId),
      ),
    )
    .orderBy(
      asc(zeroWorkflowQueueEvents.createdAt),
      asc(zeroWorkflowQueueEvents.id),
    )
    .limit(1);
  if (!event) {
    return null;
  }
  await tx
    .delete(zeroWorkflowQueueEvents)
    .where(eq(zeroWorkflowQueueEvents.id, event.id));
  return { ...event, source: "legacy" };
}

/**
 * Pop the oldest pending workflow event for the thread's queue, or return
 * null when the queue must not advance: paused, a queued user chat message
 * waiting (user messages always drain first), or an in-flight run.
 * Legacy rows (written by pre-cutover API versions) drain before new rows.
 * The claimed row is deleted; a failed dequeue re-inserts it via
 * `restoreWorkflowQueueEventAndPause`.
 */
export async function claimNextWorkflowQueueEvent(
  db: Db,
  chatThreadId: string,
): Promise<ClaimedWorkflowQueueEvent | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(chatMessageQueueLock(chatThreadId));
    const mapping = await loadWorkflowThreadMapping(tx, chatThreadId);
    if (mapping) {
      await tx.execute(legacyWorkflowQueueLock(mapping));
    }
    if (await queuePausedForThread(tx, chatThreadId, mapping)) {
      return null;
    }

    if (await hasUnclaimedQueuedUserMessage(tx, chatThreadId)) {
      return null;
    }
    if (await activeRunExistsForWorkflowThread(tx, chatThreadId)) {
      return null;
    }

    if (mapping) {
      const legacy = await claimLegacyWorkflowQueueEvent(tx, mapping);
      if (legacy) {
        return legacy;
      }
    }

    const [item] = await tx
      .select()
      .from(chatMessageQueue)
      .where(
        and(
          eq(chatMessageQueue.chatThreadId, chatThreadId),
          eq(chatMessageQueue.itemType, "workflow_event"),
        ),
      )
      .orderBy(asc(chatMessageQueue.createdAt), asc(chatMessageQueue.id))
      .limit(1);
    if (!item) {
      return null;
    }
    if (!item.triggerId || !item.triggerSource || !item.encryptedParams) {
      throw new Error(
        `Workflow event queue item ${item.id} is missing its trigger payload`,
      );
    }

    await tx.delete(chatMessageQueue).where(eq(chatMessageQueue.id, item.id));
    return {
      id: item.id,
      orgId: item.orgId,
      userId: item.userId,
      triggerId: item.triggerId,
      chatThreadId: item.chatThreadId,
      triggerSource: item.triggerSource,
      triggerBrief: item.triggerBrief,
      encryptedParams: item.encryptedParams,
      createdAt: item.createdAt,
      source: "chat_message_queue",
      workflowId: null,
    };
  });
}

/**
 * Pause is written to both homes while old API versions may still read the
 * legacy `workflow_user_trigger_threads` columns. Collapses to the
 * `chat_threads` columns once the legacy dual-read is removed.
 */
async function setPauseState(
  db: Db,
  target: {
    readonly chatThreadId: string;
    readonly mapping: Pick<
      WorkflowThreadMapping,
      "orgId" | "userId" | "workflowId"
    > | null;
  },
  pause: {
    readonly pausedAt: Date;
    readonly pauseReason: string | null;
  } | null,
  updatedAt: Date,
): Promise<void> {
  await db
    .update(chatThreads)
    .set({
      queuePausedAt: pause?.pausedAt ?? null,
      pauseReason: pause?.pauseReason ?? null,
      updatedAt,
    })
    .where(eq(chatThreads.id, target.chatThreadId));
  if (target.mapping) {
    await db
      .update(workflowUserTriggerThreads)
      .set({
        queuePausedAt: pause?.pausedAt ?? null,
        pauseReason: pause?.pauseReason ?? null,
        updatedAt,
      })
      .where(
        and(
          eq(workflowUserTriggerThreads.orgId, target.mapping.orgId),
          eq(workflowUserTriggerThreads.userId, target.mapping.userId),
          eq(workflowUserTriggerThreads.workflowId, target.mapping.workflowId),
        ),
      );
  }
}

/**
 * Put a claimed event back at its original queue position (id and createdAt
 * are preserved, in the table it was claimed from) and pause the queue so the
 * failure does not burn through the backlog. Used when run creation for a
 * dequeued event fails.
 */
export async function restoreWorkflowQueueEventAndPause(
  db: Db,
  args: {
    readonly event: ClaimedWorkflowQueueEvent;
    readonly pauseReason: string;
    readonly pausedAt: Date;
  },
): Promise<void> {
  const { event } = args;
  await db.transaction(async (tx) => {
    await tx.execute(chatMessageQueueLock(event.chatThreadId));
    const mapping = await loadWorkflowThreadMapping(tx, event.chatThreadId);
    if (mapping) {
      await tx.execute(legacyWorkflowQueueLock(mapping));
    }

    if (event.source === "legacy" && event.workflowId !== null) {
      await tx
        .insert(zeroWorkflowQueueEvents)
        .values({ ...event, workflowId: event.workflowId })
        .onConflictDoNothing();
    } else {
      await tx
        .insert(chatMessageQueue)
        .values({
          id: event.id,
          orgId: event.orgId,
          userId: event.userId,
          chatThreadId: event.chatThreadId,
          itemType: "workflow_event",
          triggerId: event.triggerId,
          triggerSource: event.triggerSource,
          triggerBrief: event.triggerBrief,
          encryptedParams: event.encryptedParams,
          createdAt: event.createdAt,
        })
        .onConflictDoNothing();
    }

    await setPauseState(
      tx,
      { chatThreadId: event.chatThreadId, mapping },
      { pausedAt: args.pausedAt, pauseReason: args.pauseReason },
      args.pausedAt,
    );
  });
}

/**
 * Chat threads that have pending queue events and an unpaused queue — the
 * safety-net sweep re-drains these in case a terminal-run drain was missed.
 */
export async function pendingWorkflowQueueThreadIds(
  db: Db,
  limit: number,
): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ chatThreadId: chatMessageQueue.chatThreadId })
    .from(chatMessageQueue)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessageQueue.chatThreadId))
    .where(
      and(
        eq(chatMessageQueue.itemType, "workflow_event"),
        isNull(chatThreads.queuePausedAt),
      ),
    )
    .limit(limit);
  const threadIds = new Set(
    rows.map((row) => {
      return row.chatThreadId;
    }),
  );
  const legacyRows = await db
    .selectDistinct({ chatThreadId: zeroWorkflowQueueEvents.chatThreadId })
    .from(zeroWorkflowQueueEvents)
    .innerJoin(
      workflowUserTriggerThreads,
      and(
        eq(workflowUserTriggerThreads.orgId, zeroWorkflowQueueEvents.orgId),
        eq(workflowUserTriggerThreads.userId, zeroWorkflowQueueEvents.userId),
        eq(
          workflowUserTriggerThreads.workflowId,
          zeroWorkflowQueueEvents.workflowId,
        ),
      ),
    )
    .where(isNull(workflowUserTriggerThreads.queuePausedAt))
    .limit(limit);
  for (const row of legacyRows) {
    threadIds.add(row.chatThreadId);
  }
  return [...threadIds].slice(0, limit);
}

export interface WorkflowQueueThreadRow {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly chatThreadId: string;
  readonly queuePausedAt: Date | null;
  readonly pauseReason: string | null;
}

/**
 * Resolve the caller-owned workflow-queue key for a chat thread. Null when
 * the thread has no workflow queue or belongs to another org/user. Pause
 * state prefers the `chat_threads` columns and falls back to the legacy
 * mapping columns written by pre-cutover API versions.
 */
export async function loadWorkflowQueueThread(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<WorkflowQueueThreadRow | null> {
  const [row] = await db
    .select({
      orgId: workflowUserTriggerThreads.orgId,
      userId: workflowUserTriggerThreads.userId,
      workflowId: workflowUserTriggerThreads.workflowId,
      legacyPausedAt: workflowUserTriggerThreads.queuePausedAt,
      legacyPauseReason: workflowUserTriggerThreads.pauseReason,
      queuePausedAt: chatThreads.queuePausedAt,
      pauseReason: chatThreads.pauseReason,
    })
    .from(workflowUserTriggerThreads)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, workflowUserTriggerThreads.chatThreadId),
    )
    .where(
      and(
        eq(workflowUserTriggerThreads.chatThreadId, args.threadId),
        eq(workflowUserTriggerThreads.orgId, args.orgId),
        eq(workflowUserTriggerThreads.userId, args.userId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    orgId: row.orgId,
    userId: row.userId,
    workflowId: row.workflowId,
    chatThreadId: args.threadId,
    queuePausedAt: row.queuePausedAt ?? row.legacyPausedAt,
    pauseReason: row.pauseReason ?? row.legacyPauseReason,
  };
}

interface WorkflowQueueRunningRun {
  readonly runId: string;
  readonly status: string;
  readonly triggerBrief: string | null;
  readonly createdAt: Date;
}

interface PendingWorkflowQueueEvent {
  readonly id: string;
  readonly triggerId: string;
  readonly triggerSource: string;
  readonly triggerBrief: string | null;
  readonly createdAt: Date;
}

export async function loadRunningWorkflowThreadRun(
  db: ReadonlyDb,
  threadId: string,
): Promise<WorkflowQueueRunningRun | null> {
  const [run] = await db
    .select({
      runId: zeroRuns.id,
      status: agentRuns.status,
      triggerBrief: zeroRuns.triggerBrief,
      createdAt: agentRuns.createdAt,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    )
    .orderBy(asc(agentRuns.createdAt))
    .limit(1);
  return run ?? null;
}

export async function listPendingWorkflowQueueEvents(
  db: ReadonlyDb,
  thread: WorkflowQueueThreadRow,
): Promise<readonly PendingWorkflowQueueEvent[]> {
  const rows = await db
    .select({
      id: chatMessageQueue.id,
      triggerId: chatMessageQueue.triggerId,
      triggerSource: chatMessageQueue.triggerSource,
      triggerBrief: chatMessageQueue.triggerBrief,
      createdAt: chatMessageQueue.createdAt,
    })
    .from(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.chatThreadId, thread.chatThreadId),
        eq(chatMessageQueue.itemType, "workflow_event"),
      ),
    );
  const legacyRows = await db
    .select({
      id: zeroWorkflowQueueEvents.id,
      triggerId: zeroWorkflowQueueEvents.triggerId,
      triggerSource: zeroWorkflowQueueEvents.triggerSource,
      triggerBrief: zeroWorkflowQueueEvents.triggerBrief,
      createdAt: zeroWorkflowQueueEvents.createdAt,
    })
    .from(zeroWorkflowQueueEvents)
    .where(
      and(
        eq(zeroWorkflowQueueEvents.orgId, thread.orgId),
        eq(zeroWorkflowQueueEvents.userId, thread.userId),
        eq(zeroWorkflowQueueEvents.workflowId, thread.workflowId),
      ),
    );
  const events: PendingWorkflowQueueEvent[] = [];
  for (const event of [...rows, ...legacyRows]) {
    if (event.triggerId !== null && event.triggerSource !== null) {
      events.push({
        id: event.id,
        triggerId: event.triggerId,
        triggerSource: event.triggerSource,
        triggerBrief: event.triggerBrief,
        createdAt: event.createdAt,
      });
    }
  }
  return events.sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

/**
 * Delete one pending event owned by the caller. Returns its chat thread id
 * for the realtime signal, or null when no such event exists.
 */
export async function deleteWorkflowQueueEventById(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly eventId: string;
  },
): Promise<{ readonly chatThreadId: string } | null> {
  const [deleted] = await db
    .delete(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.id, args.eventId),
        eq(chatMessageQueue.orgId, args.orgId),
        eq(chatMessageQueue.userId, args.userId),
        eq(chatMessageQueue.itemType, "workflow_event"),
      ),
    )
    .returning({ chatThreadId: chatMessageQueue.chatThreadId });
  if (deleted) {
    return deleted;
  }
  const [legacyDeleted] = await db
    .delete(zeroWorkflowQueueEvents)
    .where(
      and(
        eq(zeroWorkflowQueueEvents.id, args.eventId),
        eq(zeroWorkflowQueueEvents.orgId, args.orgId),
        eq(zeroWorkflowQueueEvents.userId, args.userId),
      ),
    )
    .returning({ chatThreadId: zeroWorkflowQueueEvents.chatThreadId });
  return legacyDeleted ?? null;
}

export async function clearWorkflowQueueEvents(
  db: Db,
  thread: WorkflowQueueThreadRow,
): Promise<void> {
  await db
    .delete(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.chatThreadId, thread.chatThreadId),
        eq(chatMessageQueue.itemType, "workflow_event"),
      ),
    );
  await db
    .delete(zeroWorkflowQueueEvents)
    .where(
      and(
        eq(zeroWorkflowQueueEvents.orgId, thread.orgId),
        eq(zeroWorkflowQueueEvents.userId, thread.userId),
        eq(zeroWorkflowQueueEvents.workflowId, thread.workflowId),
      ),
    );
}

/**
 * Manual pause/resume. Pause freezes consumption while intake continues;
 * resume clears both the pause timestamp and any stored reason.
 */
export async function setWorkflowQueuePause(
  db: Db,
  thread: WorkflowQueueThreadRow,
  pause: {
    readonly pausedAt: Date;
    readonly pauseReason: string | null;
  } | null,
  updatedAt: Date,
): Promise<void> {
  await setPauseState(
    db,
    { chatThreadId: thread.chatThreadId, mapping: thread },
    pause,
    updatedAt,
  );
}
