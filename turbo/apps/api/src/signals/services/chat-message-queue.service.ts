import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
} from "@vm0/db/schema/zero-workflow";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
import {
  hasUnclaimedQueuedUserMessage,
  lockUserMessageQueueThread,
} from "./zero-chat-queued-message.service";

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
  activePreviousRunPolicy: z.enum(["block", "allow"]),
  allowClaimedOnceScheduleAutomation: z.boolean().optional(),
});

/**
 * The caller-supplied remainder of `RunWorkflowAutomationNowArgs` persisted with
 * a queued event. Fields the automation-run command derives from the automation row
 * itself (default prompt, default callbacks) stay undefined and are rebuilt
 * at dequeue time.
 */
export interface WorkflowQueueEventParams {
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
  readonly activePreviousRunPolicy: "block" | "allow";
  readonly allowClaimedOnceScheduleAutomation?: boolean;
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
  return run !== undefined;
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

type WorkflowQueueAdmission =
  | { readonly kind: "inserted"; readonly eventId: string }
  | { readonly kind: "coalesced" };
type WorkflowQueueAdmissionAttempt =
  | WorkflowQueueAdmission
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

    if (
      args.coalescePendingScheduleRun &&
      automation.kind === "schedule" &&
      (await pendingTickExistsForAutomation(tx, automation.id))
    ) {
      return { kind: "coalesced" };
    }

    if (encryptedParams === undefined) {
      return { kind: "payload-required" };
    }

    const [inserted] = await tx
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
      .returning({ id: chatMessageQueue.id });
    if (!inserted) {
      throw new Error("Workflow queue event insert returned no row");
    }
    return { kind: "inserted", eventId: inserted.id };
  });
}

/**
 * Persist every fired automation event before run preparation. Serialized per
 * chat thread via an advisory lock. Schedule ticks coalesce per automation: at
 * most one pending tick.
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
    return initial;
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
      return retryWithoutPayload;
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
  return final;
}

export interface PendingWorkflowQueueEvent {
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
 * Load the oldest pending workflow event for the thread's queue, or return
 * null when the queue must not advance: paused, a queued user chat message
 * waiting (user messages always drain first), or an in-flight run.
 * The row stays pending until the final run persistence transaction claims it.
 */
export async function loadNextWorkflowQueueEvent(
  db: Db,
  chatThreadId: string,
  queueItemCreatedBefore?: Date,
): Promise<PendingWorkflowQueueEvent | null> {
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
          queueItemCreatedBefore
            ? lt(chatMessageQueue.createdAt, queueItemCreatedBefore)
            : undefined,
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

async function workflowQueueEventIsHead(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
  },
): Promise<boolean> {
  const [head] = await db
    .select({ id: chatMessageQueue.id })
    .from(chatMessageQueue)
    .where(
      and(
        eq(chatMessageQueue.chatThreadId, args.chatThreadId),
        eq(chatMessageQueue.itemType, "workflow_event"),
      ),
    )
    .orderBy(asc(chatMessageQueue.createdAt), asc(chatMessageQueue.id))
    .limit(1);
  return head?.id === args.eventId;
}

/**
 * Consume a stale workflow event only while it still owns the runnable queue
 * head. This uses the same thread row lock as final queue-first run claims.
 */
export async function consumeWorkflowQueueEvent(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!(await lockUserMessageQueueThread(tx, args.chatThreadId))) {
      return false;
    }
    if (
      (await queuePausedForThread(tx, args.chatThreadId)) ||
      (await hasUnclaimedQueuedUserMessage(tx, args.chatThreadId)) ||
      (await activeRunExistsForWorkflowThread(tx, args.chatThreadId)) ||
      !(await workflowQueueEventIsHead(tx, args))
    ) {
      return false;
    }
    const deleted = await tx
      .delete(chatMessageQueue)
      .where(
        and(
          eq(chatMessageQueue.id, args.eventId),
          eq(chatMessageQueue.chatThreadId, args.chatThreadId),
          eq(chatMessageQueue.itemType, "workflow_event"),
        ),
      )
      .returning({ id: chatMessageQueue.id });
    return deleted.length === 1;
  });
}

/**
 * Pause a workflow queue after a run-creation error while preserving the
 * pending event in place.
 */
export async function pauseWorkflowQueueEventAfterRunFailure(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
    readonly pauseReason: string;
    readonly pausedAt: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockUserMessageQueueThread(tx, args.chatThreadId))) {
      return;
    }
    if (!(await workflowQueueEventIsHead(tx, args))) {
      return;
    }

    await setPauseState(
      tx,
      args.chatThreadId,
      { pausedAt: args.pausedAt, pauseReason: args.pauseReason },
      args.pausedAt,
    );
  });
}

/**
 * Chat threads with stale pending work — the safety-net sweep re-drains these
 * after the immediate admission or terminal-run callback had time to finish.
 * User messages remain drainable while workflow automation intake is paused.
 */
export async function staleChatThreadQueueThreadIds(
  db: Db,
  args: {
    readonly staleBefore: Date;
    readonly limit: number;
  },
): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ chatThreadId: chatMessageQueue.chatThreadId })
    .from(chatMessageQueue)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessageQueue.chatThreadId))
    .where(
      and(
        lt(chatMessageQueue.createdAt, args.staleBefore),
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
    .limit(args.limit);
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

interface PendingWorkflowQueueEventSummary {
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
): Promise<readonly PendingWorkflowQueueEventSummary[]> {
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
  const events: PendingWorkflowQueueEventSummary[] = [];
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
