import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { FeatureSwitchKey } from "@vm0/core";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
} from "@vm0/db/schema/zero-workflow";
import { zeroWorkflowQueueEvents } from "@vm0/db/schema/zero-workflow-queue";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../external/db";
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

function workflowQueueLock(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}) {
  const key = `workflow_queue:${args.orgId}:${args.userId}:${args.workflowId}`;
  return sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
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

type WorkflowQueueAdmission = "proceed" | "enqueued";

/**
 * Decide whether a fired trigger event may create its run now or must wait in
 * the workflow queue. Serialized per (org, user, workflow) via an advisory
 * lock. Schedule ticks coalesce per trigger: at most one pending tick.
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
  const queueKey = {
    orgId: trigger.orgId,
    userId: trigger.ownerUserId,
    workflowId: trigger.workflowId,
  };
  const encryptedParams = await encryptWorkflowQueueEventParams(args.params, {
    userId: trigger.ownerUserId,
    orgId: trigger.orgId,
  });

  return await db.transaction(async (tx) => {
    await tx.execute(workflowQueueLock(queueKey));

    const [threadRow] = await tx
      .select({ queuePausedAt: workflowUserTriggerThreads.queuePausedAt })
      .from(workflowUserTriggerThreads)
      .where(
        and(
          eq(workflowUserTriggerThreads.orgId, queueKey.orgId),
          eq(workflowUserTriggerThreads.userId, queueKey.userId),
          eq(workflowUserTriggerThreads.workflowId, queueKey.workflowId),
        ),
      )
      .limit(1);
    const paused = threadRow?.queuePausedAt != null;

    if (!paused) {
      const busy = await activeRunExistsForWorkflowThread(
        tx,
        args.chatThreadId,
      );
      if (!busy) {
        const [pending] = await tx
          .select({ id: zeroWorkflowQueueEvents.id })
          .from(zeroWorkflowQueueEvents)
          .where(
            and(
              eq(zeroWorkflowQueueEvents.orgId, queueKey.orgId),
              eq(zeroWorkflowQueueEvents.userId, queueKey.userId),
              eq(zeroWorkflowQueueEvents.workflowId, queueKey.workflowId),
            ),
          )
          .limit(1);
        if (!pending) {
          return "proceed";
        }
      }
    }

    if (trigger.kind === "schedule") {
      const [tick] = await tx
        .select({ id: zeroWorkflowQueueEvents.id })
        .from(zeroWorkflowQueueEvents)
        .where(eq(zeroWorkflowQueueEvents.triggerId, trigger.id))
        .limit(1);
      if (tick) {
        return "enqueued";
      }
    }

    await tx.insert(zeroWorkflowQueueEvents).values({
      orgId: queueKey.orgId,
      userId: queueKey.userId,
      workflowId: queueKey.workflowId,
      triggerId: trigger.id,
      chatThreadId: args.chatThreadId,
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
  readonly workflowId: string;
  readonly triggerId: string;
  readonly chatThreadId: string;
  readonly triggerSource: string;
  readonly triggerBrief: string | null;
  readonly encryptedParams: string;
  readonly createdAt: Date;
}

/**
 * Pop the oldest pending event for the thread's workflow queue, or return
 * null when the queue must not advance: paused, a queued user chat message
 * waiting (user messages always drain first), or an in-flight run.
 * The claimed row is deleted; a failed dequeue re-inserts it via
 * `restoreWorkflowQueueEvent`.
 */
export async function claimNextWorkflowQueueEvent(
  db: Db,
  chatThreadId: string,
): Promise<ClaimedWorkflowQueueEvent | null> {
  return await db.transaction(async (tx) => {
    const [threadRow] = await tx
      .select({
        orgId: workflowUserTriggerThreads.orgId,
        userId: workflowUserTriggerThreads.userId,
        workflowId: workflowUserTriggerThreads.workflowId,
        queuePausedAt: workflowUserTriggerThreads.queuePausedAt,
      })
      .from(workflowUserTriggerThreads)
      .where(eq(workflowUserTriggerThreads.chatThreadId, chatThreadId))
      .limit(1);
    if (!threadRow || threadRow.queuePausedAt != null) {
      return null;
    }

    await tx.execute(workflowQueueLock(threadRow));

    if (await hasUnclaimedQueuedUserMessage(tx, chatThreadId)) {
      return null;
    }
    if (await activeRunExistsForWorkflowThread(tx, chatThreadId)) {
      return null;
    }

    const [event] = await tx
      .select()
      .from(zeroWorkflowQueueEvents)
      .where(
        and(
          eq(zeroWorkflowQueueEvents.orgId, threadRow.orgId),
          eq(zeroWorkflowQueueEvents.userId, threadRow.userId),
          eq(zeroWorkflowQueueEvents.workflowId, threadRow.workflowId),
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
    return event;
  });
}

/**
 * Put a claimed event back at its original queue position (id and createdAt
 * are preserved) and pause the queue so the failure does not burn through the
 * backlog. Used when run creation for a dequeued event fails.
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
    await tx.execute(workflowQueueLock(event));
    await tx
      .insert(zeroWorkflowQueueEvents)
      .values(event)
      .onConflictDoNothing();
    await tx
      .update(workflowUserTriggerThreads)
      .set({
        queuePausedAt: args.pausedAt,
        pauseReason: args.pauseReason,
        updatedAt: args.pausedAt,
      })
      .where(
        and(
          eq(workflowUserTriggerThreads.orgId, event.orgId),
          eq(workflowUserTriggerThreads.userId, event.userId),
          eq(workflowUserTriggerThreads.workflowId, event.workflowId),
        ),
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
  return rows.map((row) => {
    return row.chatThreadId;
  });
}
