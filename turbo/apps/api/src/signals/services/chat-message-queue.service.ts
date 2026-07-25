import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
} from "@vm0/db/schema/zero-workflow";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import {
  internalRunCallbackKinds,
  type InternalRunCallbackKind,
} from "./internal-run-callback";
import { browserCleanupRequiredForChatThread } from "./zero-chat-active-run.service";
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
  if (run !== undefined) {
    return true;
  }
  return await browserCleanupRequiredForChatThread(db, threadId);
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

type WorkflowQueueAdmission = "proceed" | "enqueued";
type WorkflowQueueAdmissionAttempt =
  | { readonly kind: "proceed" }
  | { readonly kind: "enqueued" }
  | { readonly kind: "payload-required" };

interface WorkflowQueueAdmissionArgs {
  readonly automation: typeof zeroWorkflowAutomations.$inferSelect;
  readonly chatThreadId: string;
  readonly triggerSource: TriggerSource;
  readonly triggerBrief: string | undefined;
  readonly coalescePendingScheduleRun: boolean;
  readonly params: WorkflowQueueEventParams;
}

async function attemptWorkflowQueueAdmission(
  db: Db,
  args: WorkflowQueueAdmissionArgs,
  encryptedParams: string | undefined,
): Promise<WorkflowQueueAdmissionAttempt> {
  const { automation } = args;
  return await db.transaction(async (tx) => {
    await tx.execute(chatMessageQueueLock(args.chatThreadId));

    const paused = await queuePausedForThread(tx, args.chatThreadId);

    if (!paused) {
      const busy = await activeRunExistsForWorkflowThread(
        tx,
        args.chatThreadId,
      );
      if (
        !busy &&
        !(await hasUnclaimedQueuedUserMessage(tx, args.chatThreadId)) &&
        !(await pendingWorkflowEventExists(tx, args.chatThreadId))
      ) {
        return { kind: "proceed" };
      }
    }

    if (
      args.coalescePendingScheduleRun &&
      automation.kind === "schedule" &&
      (await pendingTickExistsForAutomation(tx, automation.id))
    ) {
      return { kind: "enqueued" };
    }

    if (encryptedParams === undefined) {
      return { kind: "payload-required" };
    }

    await tx.insert(chatMessageQueue).values({
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      chatThreadId: args.chatThreadId,
      itemType: "workflow_event",
      automationId: automation.id,
      triggerSource: args.triggerSource,
      triggerBrief: args.triggerBrief ?? null,
      encryptedParams,
    });
    return { kind: "enqueued" };
  });
}

/**
 * Decide whether a fired automation event may create its run now or must wait in
 * the chat message queue. Serialized per chat thread via an advisory lock.
 * Schedule ticks coalesce per automation: at most one pending tick.
 * Queue payload encryption runs only after a locked attempt requires it and
 * outside the transaction; the subsequent locked attempt owns the final state.
 */
export async function admitWorkflowAutomationEvent(
  db: Db,
  args: WorkflowQueueAdmissionArgs,
): Promise<WorkflowQueueAdmission> {
  const { automation } = args;
  const initial = await attemptWorkflowQueueAdmission(db, args, undefined);
  if (initial.kind !== "payload-required") {
    return initial.kind;
  }

  const encryptedParamsResult = await settle(
    encryptWorkflowQueueEventParams(args.params, {
      userId: automation.ownerUserId,
      orgId: automation.orgId,
    }),
  );
  if (!encryptedParamsResult.ok) {
    const retryWithoutPayload = await attemptWorkflowQueueAdmission(
      db,
      args,
      undefined,
    );
    if (retryWithoutPayload.kind !== "payload-required") {
      return retryWithoutPayload.kind;
    }
    throw encryptedParamsResult.error;
  }

  const final = await attemptWorkflowQueueAdmission(
    db,
    args,
    encryptedParamsResult.value,
  );
  if (final.kind === "payload-required") {
    throw new Error("Workflow queue admission still required encrypted params");
  }
  return final.kind;
}

export interface ClaimedWorkflowQueueEvent {
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

/**
 * Pop the oldest pending workflow event for the thread's queue, or return
 * null when the queue must not advance: paused, a queued user chat message
 * waiting (user messages always drain first), or an in-flight run.
 * The claimed row is deleted; a failed dequeue re-inserts it via
 * `restoreWorkflowQueueEventAndPause`.
 */
export async function claimNextWorkflowQueueEvent(
  db: Db,
  chatThreadId: string,
): Promise<ClaimedWorkflowQueueEvent | null> {
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
      .select({
        id: chatMessageQueue.id,
        orgId: chatMessageQueue.orgId,
        userId: chatMessageQueue.userId,
        automationId: chatMessageQueue.automationId,
        chatThreadId: chatMessageQueue.chatThreadId,
        triggerSource: chatMessageQueue.triggerSource,
        triggerBrief: chatMessageQueue.triggerBrief,
        encryptedParams: chatMessageQueue.encryptedParams,
        createdAt: chatMessageQueue.createdAt,
      })
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
    if (!item.automationId || !item.triggerSource || !item.encryptedParams) {
      throw new Error(
        `Workflow event queue item ${item.id} is missing its automation payload`,
      );
    }

    await tx.delete(chatMessageQueue).where(eq(chatMessageQueue.id, item.id));
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

/**
 * Put a claimed event back at its original queue position (id and createdAt
 * are preserved) and pause the queue so the failure does not burn through
 * the backlog. Used when run creation for a dequeued event fails.
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

    await tx
      .insert(chatMessageQueue)
      .values({
        id: event.id,
        orgId: event.orgId,
        userId: event.userId,
        chatThreadId: event.chatThreadId,
        itemType: "workflow_event",
        automationId: event.automationId,
        triggerSource: event.triggerSource,
        triggerBrief: event.triggerBrief,
        encryptedParams: event.encryptedParams,
        createdAt: event.createdAt,
      })
      .onConflictDoNothing();

    await setPauseState(
      tx,
      event.chatThreadId,
      { pausedAt: args.pausedAt, pauseReason: args.pauseReason },
      args.pausedAt,
    );
  });
}

/**
 * Chat threads with pending work — the safety-net sweep re-drains these in
 * case admission or a terminal-run callback missed its immediate drain.
 * User messages remain drainable while workflow automation intake is paused.
 */
export async function pendingChatThreadQueueThreadIds(
  db: Db,
  limit: number,
): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ chatThreadId: chatMessageQueue.chatThreadId })
    .from(chatMessageQueue)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessageQueue.chatThreadId))
    .where(
      and(
        or(
          inArray(chatMessageQueue.itemType, [
            "user_message",
            "slack_user_message",
            "feishu_user_message",
          ]),
          and(
            eq(chatMessageQueue.itemType, "workflow_event"),
            isNull(chatThreads.queuePausedAt),
          ),
        ),
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
