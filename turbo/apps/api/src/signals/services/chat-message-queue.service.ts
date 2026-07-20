import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
} from "@vm0/db/schema/zero-workflow";
import { and, asc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
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
import { insertChatMessage } from "./zero-chat-message.service";
import { appendQueuedRunAssistantMarker } from "./zero-chat-queue-marker.service";

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
 * The caller-supplied remainder of `RunWorkflowAutomationNowArgs` persisted with
 * a queued event. Fields the automation-run command derives from the automation row
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

function chatMessageQueueLock(chatThreadId: string) {
  const key = `chat_message_queue:${chatThreadId}`;
  return sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

async function queuePausedForThread(
  db: Db,
  chatThreadId: string,
): Promise<boolean> {
  const [thread] = await db
    .select({ queuePausedAt: chatThreads.queuePausedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return thread !== undefined && thread.queuePausedAt !== null;
}

/**
 * Pre-dispatch chat candidates do not own the thread until their user message
 * is durable. Candidate markers let concurrent contenders coexist briefly
 * while the thread-row claim chooses exactly one dispatchable run.
 */
function chatRunOwnsThreadCondition(): SQL {
  return sql`
    (
      NOT EXISTS (
        SELECT 1
        FROM ${agentRunCallbacks}
        WHERE ${agentRunCallbacks.runId} = ${zeroRuns.id}
          AND ${agentRunCallbacks.internalKind} = 'chat'
          AND (
            ${agentRunCallbacks.payload}->>'queuedMessageId' IS NOT NULL
            OR ${agentRunCallbacks.payload}->>'workflowQueueEventId' IS NOT NULL
          )
      )
      OR EXISTS (
        SELECT 1
        FROM ${chatMessages}
        WHERE ${chatMessages.runId} = ${zeroRuns.id}
          AND ${chatMessages.role} = 'user'
      )
    )
  `;
}

export async function activeChatThreadOwnerExists(
  db: ReadonlyDb,
  args: {
    readonly threadId: string;
    readonly excludeRunId?: string;
  },
): Promise<boolean> {
  const [run] = await db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, args.threadId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
        args.excludeRunId ? ne(zeroRuns.id, args.excludeRunId) : undefined,
        chatRunOwnsThreadCondition(),
      ),
    )
    .limit(1);
  return run !== undefined;
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
  return await activeChatThreadOwnerExists(db, { threadId });
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
  return row !== undefined;
}

async function pendingTickExistsForAutomation(
  db: Db,
  automationId: string,
): Promise<boolean> {
  const [tick] = await db
    .select({ id: chatMessageQueue.id })
    .from(chatMessageQueue)
    .where(eq(chatMessageQueue.automationId, automationId))
    .limit(1);
  return tick !== undefined;
}

export interface WorkflowQueueEvent {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly triggerSource: string;
  readonly triggerBrief: string | null;
  readonly encryptedParams: string;
  readonly createdAt: Date;
}

function workflowQueueEventFromRow(
  item: typeof chatMessageQueue.$inferSelect,
): WorkflowQueueEvent {
  if (
    item.itemType !== "workflow_event" ||
    !item.automationId ||
    !item.triggerSource ||
    !item.encryptedParams
  ) {
    throw new Error(
      `Workflow event queue item ${item.id} is missing its automation payload`,
    );
  }
  return {
    id: item.id,
    orgId: item.orgId,
    userId: item.userId,
    automationId: item.automationId,
    chatThreadId: item.chatThreadId,
    triggerSource: item.triggerSource,
    triggerBrief: item.triggerBrief,
    encryptedParams: item.encryptedParams,
    createdAt: item.createdAt,
  };
}

type WorkflowQueueAdmission =
  | { readonly kind: "proceed"; readonly event: WorkflowQueueEvent }
  | { readonly kind: "enqueued" };

/**
 * Persist a fired automation event before deciding whether its queue head may
 * create a run inline. Schedule ticks coalesce per automation, while every
 * non-coalesced event has a durable row before run preparation begins.
 */
export async function admitWorkflowAutomationEvent(
  db: Db,
  args: {
    readonly automation: typeof zeroWorkflowAutomations.$inferSelect;
    readonly chatThreadId: string;
    readonly triggerSource: TriggerSource;
    readonly triggerBrief: string | undefined;
    readonly params: WorkflowQueueEventParams;
  },
): Promise<WorkflowQueueAdmission> {
  const { automation } = args;
  const encryptedParams = await encryptWorkflowQueueEventParams(args.params, {
    userId: automation.ownerUserId,
    orgId: automation.orgId,
  });

  return await db.transaction(async (tx) => {
    await tx.execute(chatMessageQueueLock(args.chatThreadId));

    if (
      automation.kind === "schedule" &&
      (await pendingTickExistsForAutomation(tx, automation.id))
    ) {
      return { kind: "enqueued" };
    }

    const paused = await queuePausedForThread(tx, args.chatThreadId);
    const mayProceed =
      !paused &&
      !(await hasUnclaimedQueuedUserMessage(tx, args.chatThreadId)) &&
      !(await activeRunExistsForWorkflowThread(tx, args.chatThreadId)) &&
      !(await pendingWorkflowEventExists(tx, args.chatThreadId));

    const [item] = await tx
      .insert(chatMessageQueue)
      .values({
        orgId: automation.orgId,
        userId: automation.ownerUserId,
        chatThreadId: args.chatThreadId,
        itemType: "workflow_event",
        automationId: automation.id,
        triggerSource: args.triggerSource,
        triggerBrief: args.triggerBrief ?? null,
        encryptedParams,
      })
      .returning();
    if (!item) {
      throw new Error("Workflow event queue insert returned no row");
    }
    return mayProceed
      ? { kind: "proceed", event: workflowQueueEventFromRow(item) }
      : { kind: "enqueued" };
  });
}

/**
 * Read the oldest dispatchable workflow event without consuming it. Expensive
 * run preparation happens after this read; the pre-dispatch claim rechecks and
 * deletes the exact head only when its candidate run wins ownership.
 */
export async function peekNextWorkflowQueueEvent(
  db: Db,
  chatThreadId: string,
): Promise<WorkflowQueueEvent | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(chatMessageQueueLock(chatThreadId));
    if (await queuePausedForThread(tx, chatThreadId)) {
      return null;
    }

    if (await hasUnclaimedQueuedUserMessage(tx, chatThreadId)) {
      return null;
    }
    if (await activeRunExistsForWorkflowThread(tx, chatThreadId)) {
      return null;
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
    return workflowQueueEventFromRow(item);
  });
}

async function setPauseState(
  db: Db,
  chatThreadId: string,
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
    .where(eq(chatThreads.id, chatThreadId));
}

export async function claimWorkflowQueueEventForRun(
  db: Db,
  args: {
    readonly event: WorkflowQueueEvent;
    readonly runId: string;
    readonly prompt: string;
  },
): Promise<boolean> {
  const { event } = args;
  return await db.transaction(async (tx) => {
    const [thread] = await tx
      .select({ queuePausedAt: chatThreads.queuePausedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, event.chatThreadId))
      .for("update");
    if (!thread || thread.queuePausedAt !== null) {
      return false;
    }

    const [run] = await tx
      .select({
        status: agentRuns.status,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.id, args.runId))
      .for("update", { of: agentRuns });
    if (
      !run ||
      run.chatThreadId !== event.chatThreadId ||
      (run.status !== "queued" && run.status !== "pending")
    ) {
      return false;
    }

    const [marker] = await tx
      .select({ id: agentRunCallbacks.id })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, args.runId),
          eq(agentRunCallbacks.internalKind, "chat"),
          sql`${agentRunCallbacks.payload}->>'workflowQueueEventId' = ${event.id}`,
        ),
      )
      .limit(1);
    if (!marker) {
      throw new Error(
        `Workflow queue candidate ${args.runId} is missing event marker ${event.id}`,
      );
    }

    if (await hasUnclaimedQueuedUserMessage(tx, event.chatThreadId)) {
      return false;
    }
    if (
      await activeChatThreadOwnerExists(tx, {
        threadId: event.chatThreadId,
        excludeRunId: args.runId,
      })
    ) {
      return false;
    }

    const [head] = await tx
      .select({ id: chatMessageQueue.id })
      .from(chatMessageQueue)
      .where(
        and(
          eq(chatMessageQueue.chatThreadId, event.chatThreadId),
          eq(chatMessageQueue.itemType, "workflow_event"),
        ),
      )
      .orderBy(asc(chatMessageQueue.createdAt), asc(chatMessageQueue.id))
      .for("update")
      .limit(1);
    if (head?.id !== event.id) {
      return false;
    }

    const [deleted] = await tx
      .delete(chatMessageQueue)
      .where(
        and(
          eq(chatMessageQueue.id, event.id),
          eq(chatMessageQueue.chatThreadId, event.chatThreadId),
          eq(chatMessageQueue.itemType, "workflow_event"),
        ),
      )
      .returning({ id: chatMessageQueue.id });
    if (!deleted) {
      return false;
    }

    const message = await insertChatMessage(tx, {
      chatThreadId: event.chatThreadId,
      role: "user",
      content: args.prompt,
      runId: args.runId,
      runGroupId: event.automationId,
    });
    if (!message) {
      throw new Error(
        `Workflow queue event ${event.id} user message was not inserted`,
      );
    }
    if (run.status === "queued") {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: event.chatThreadId,
        runId: args.runId,
        runGroupId: event.automationId,
        createdAfter: message.createdAt,
      });
    }
    return true;
  });
}

/** Consume a stale/invalid event only if it is still the workflow FIFO head. */
export async function discardWorkflowQueueEvent(
  db: Db,
  event: WorkflowQueueEvent,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await tx.execute(chatMessageQueueLock(event.chatThreadId));
    const [head] = await tx
      .select({ id: chatMessageQueue.id })
      .from(chatMessageQueue)
      .where(
        and(
          eq(chatMessageQueue.chatThreadId, event.chatThreadId),
          eq(chatMessageQueue.itemType, "workflow_event"),
        ),
      )
      .orderBy(asc(chatMessageQueue.createdAt), asc(chatMessageQueue.id))
      .for("update")
      .limit(1);
    if (head?.id !== event.id) {
      return false;
    }
    const deleted = await tx
      .delete(chatMessageQueue)
      .where(eq(chatMessageQueue.id, event.id))
      .returning({ id: chatMessageQueue.id });
    return deleted.length > 0;
  });
}

/** Pause only while the failed pre-dispatch event is still pending. */
export async function pauseWorkflowQueueEvent(
  db: Db,
  args: {
    readonly event: WorkflowQueueEvent;
    readonly pauseReason: string;
    readonly pausedAt: Date;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await tx.execute(chatMessageQueueLock(args.event.chatThreadId));
    const [thread] = await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.event.chatThreadId))
      .for("update");
    if (!thread) {
      return false;
    }
    const [pending] = await tx
      .select({ id: chatMessageQueue.id })
      .from(chatMessageQueue)
      .where(
        and(
          eq(chatMessageQueue.id, args.event.id),
          eq(chatMessageQueue.chatThreadId, args.event.chatThreadId),
          eq(chatMessageQueue.itemType, "workflow_event"),
        ),
      )
      .for("update")
      .limit(1);
    if (!pending) {
      return false;
    }
    await setPauseState(
      tx,
      args.event.chatThreadId,
      { pausedAt: args.pausedAt, pauseReason: args.pauseReason },
      args.pausedAt,
    );
    return true;
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
  return rows.map((row) => {
    return row.chatThreadId;
  });
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
 * the thread has no workflow queue or belongs to another org/user.
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
      orgId: workflowUserAutomationThreads.orgId,
      userId: workflowUserAutomationThreads.userId,
      workflowId: workflowUserAutomationThreads.workflowId,
      queuePausedAt: chatThreads.queuePausedAt,
      pauseReason: chatThreads.pauseReason,
    })
    .from(workflowUserAutomationThreads)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, workflowUserAutomationThreads.chatThreadId),
    )
    .where(
      and(
        eq(workflowUserAutomationThreads.chatThreadId, args.threadId),
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
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
    queuePausedAt: row.queuePausedAt,
    pauseReason: row.pauseReason,
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
  readonly automationId: string;
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
        chatRunOwnsThreadCondition(),
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
      automationId: chatMessageQueue.automationId,
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
  const events: PendingWorkflowQueueEvent[] = [];
  for (const event of rows) {
    if (event.automationId !== null && event.triggerSource !== null) {
      events.push({
        id: event.id,
        automationId: event.automationId,
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
  return deleted ?? null;
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
  await setPauseState(db, thread.chatThreadId, pause, updatedAt);
}
