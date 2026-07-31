import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatAutomationContext } from "@vm0/db/schema/chat-automation-context";
import { chatEventInputParams } from "@vm0/db/schema/chat-event-input-params";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import {
  hasPendingUserChatQueueEvent,
  listPendingChatQueueEvents,
  loadPendingChatQueueEvent,
  lockChatQueueThread,
  staleChatEventQueueThreadIds,
} from "./chat-event-queue.service";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import {
  internalRunCallbackKinds,
  type InternalRunCallbackKind,
} from "./internal-run-callback";
import {
  insertChatEvent,
  replaceChatEvent,
  revokeChatEvent,
} from "./zero-chat-event.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { createUserMessageDocument } from "./zero-chat-user-message.service";

const WORKFLOW_QUEUE_EVENT_PARAMS_KEY = "__workflow_queue_event_params__";
const automationEventRevoker = alias(chatEvents, "automation_event_revoker");

export type WorkflowQueueAdmissionTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

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

/** Queue-only run parameters retained as persistent-secret ciphertext. */
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

async function chatEventQueueAdmissionLock(
  tx: WorkflowQueueAdmissionTransaction,
  chatThreadId: string,
): Promise<void> {
  // Serialize every admission and claim transaction for the same chat thread.
  const lockKey = `chat_event_queue:${chatThreadId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

/** Any active thread-bound run preserves strict per-thread serialization. */
async function activeRunExistsForWorkflowThread(
  db: Pick<Db, "select">,
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
  db: Pick<Db, "select">,
  automationId: string,
): Promise<boolean> {
  const [tick] = await db
    .select({ id: chatEvents.id })
    .from(chatAutomationContext)
    .innerJoin(
      chatEvents,
      and(
        eq(chatEvents.contextType, "automation"),
        eq(chatEvents.contextId, chatAutomationContext.id),
      ),
    )
    .where(
      and(
        eq(chatAutomationContext.automationId, automationId),
        chatEventTypeIn(["input.automation"]),
        isNull(chatEvents.runId),
        notExists(
          db
            .select({ id: automationEventRevoker.id })
            .from(automationEventRevoker)
            .where(eq(automationEventRevoker.revokesEventId, chatEvents.id)),
        ),
      ),
    )
    .limit(1);
  return tick !== undefined;
}

type WorkflowQueueAdmission =
  | { readonly kind: "inserted"; readonly eventId: string }
  | { readonly kind: "coalesced" };
type WorkflowQueueAdmissionAttempt =
  | WorkflowQueueAdmission
  | { readonly kind: "payload-required" };

export type PersistWorkflowQueueSourceTransition = (
  tx: WorkflowQueueAdmissionTransaction,
) => Promise<void>;

interface WorkflowQueueAdmissionArgs {
  readonly automation: typeof zeroWorkflowAutomations.$inferSelect;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly triggerSource: TriggerSource;
  readonly triggerBrief: string | undefined;
  readonly coalescePendingScheduleRun: boolean;
  readonly params: WorkflowQueueEventParams;
  /**
   * Atomically transitions a provider-owned source event only after its
   * workflow queue item has been inserted. Throwing rolls back both writes.
   */
  readonly persistSourceTransition?: PersistWorkflowQueueSourceTransition;
}

async function attemptWorkflowQueueAdmission(
  db: Db,
  args: WorkflowQueueAdmissionArgs,
  encryptedParams: string | undefined,
): Promise<WorkflowQueueAdmissionAttempt> {
  const { automation } = args;
  return await db.transaction(async (tx) => {
    await chatEventQueueAdmissionLock(tx, args.chatThreadId);

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

    const inserted = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.automation",
      content: null,
      userMessage: createUserMessageDocument({
        text: null,
        nonContentPart: {
          type: "automation",
          workflowName: args.workflowName,
          workflowId: automation.workflowId,
          ...(args.triggerBrief === undefined
            ? {}
            : { automationBrief: args.triggerBrief }),
        },
      }),
      runId: null,
      automationId: automation.id,
      triggerSource: args.triggerSource,
      triggerBrief: args.triggerBrief ?? null,
      encryptedParams,
    });
    if (!inserted) {
      throw new Error("Workflow queue event insert returned no row");
    }
    await args.persistSourceTransition?.(tx);
    return { kind: "inserted", eventId: inserted.id };
  });
}

/**
 * Persist every fired automation as a pending input event. The locked
 * coalescing predicate is unchanged: schedule automations have at most one
 * unclaimed, unrevoked event when the caller enables coalescing.
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
  readonly userId: string;
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly triggerSource: TriggerSource;
  readonly triggerBrief: string | null;
  readonly encryptedParams: string;
  readonly createdAt: Date;
}

/**
 * Load the runnable automation head. Pending user events always win and any
 * active run blocks the whole thread.
 *
 * During code-before-migration deployment, legacy queue rows simply have no
 * event counterpart yet and therefore return null rather than failing.
 */
export async function loadNextWorkflowQueueEvent(
  db: Db,
  chatThreadId: string,
  queueItemCreatedBefore?: Date,
): Promise<PendingWorkflowQueueEvent | null> {
  return await db.transaction(async (tx) => {
    await chatEventQueueAdmissionLock(tx, chatThreadId);
    if (await hasPendingUserChatQueueEvent(tx, chatThreadId)) {
      return null;
    }
    if (await activeRunExistsForWorkflowThread(tx, chatThreadId)) {
      return null;
    }

    const pending = await listPendingChatQueueEvents(
      tx,
      chatThreadId,
      queueItemCreatedBefore,
    );
    const head = pending[0];
    if (!head || head.eventType !== "input.automation") {
      return null;
    }
    const [event] = await tx
      .select({
        id: chatEvents.id,
        userId: chatThreads.userId,
        automationId: chatAutomationContext.automationId,
        chatThreadId: chatEvents.chatThreadId,
        triggerSource: chatEvents.triggerSource,
        triggerBrief: chatAutomationContext.triggerBrief,
        encryptedParams: chatEventInputParams.encryptedParams,
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .leftJoin(
        chatEventInputParams,
        eq(chatEventInputParams.eventId, chatEvents.id),
      )
      .leftJoin(
        chatAutomationContext,
        and(
          eq(chatEvents.contextType, "automation"),
          eq(chatAutomationContext.id, chatEvents.contextId),
        ),
      )
      .where(eq(chatEvents.id, head.id))
      .limit(1);
    if (!event) {
      return null;
    }
    if (!event.automationId || !event.triggerSource || !event.encryptedParams) {
      throw new Error(
        `Workflow queue event ${event.id} is missing its typed payload`,
      );
    }
    return {
      ...event,
      automationId: event.automationId,
      triggerSource: event.triggerSource,
      encryptedParams: event.encryptedParams,
    };
  });
}

async function loadAutomationRejectionPayload(
  db: Pick<Db, "select">,
  eventId: string,
) {
  const [event] = await db
    .select({
      automationId: chatAutomationContext.automationId,
      triggerSource: chatEvents.triggerSource,
      triggerBrief: chatAutomationContext.triggerBrief,
      userMessage: chatEvents.userMessage,
      workflowId: zeroWorkflows.id,
      workflowName: zeroWorkflows.name,
    })
    .from(chatEvents)
    .leftJoin(
      chatAutomationContext,
      and(
        eq(chatEvents.contextType, "automation"),
        eq(chatAutomationContext.id, chatEvents.contextId),
      ),
    )
    .leftJoin(
      zeroWorkflowAutomations,
      eq(zeroWorkflowAutomations.id, chatAutomationContext.automationId),
    )
    .leftJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  return event ?? null;
}

async function pendingAutomationEventStillExists(
  db: Pick<Db, "select">,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
  },
): Promise<boolean> {
  const pending = await loadPendingChatQueueEvent(db, args);
  return pending?.eventType === "input.automation";
}

/** Reject an unfireable automation event while it still owns the queue head. */
export async function rejectWorkflowQueueEvent(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
    readonly reason: string;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, args.chatThreadId))) {
      return false;
    }
    // The event owned the runnable head before launch. A user message or run
    // may win the thread while launch is in flight, but a permanent conflict
    // must still consume this trigger instead of making it retry later.
    if (!(await pendingAutomationEventStillExists(tx, args))) {
      return false;
    }
    const payload = await loadAutomationRejectionPayload(tx, args.eventId);
    if (!payload?.automationId || !payload.triggerSource) {
      return false;
    }
    const userMessage =
      payload.userMessage ??
      (payload.workflowName === null
        ? null
        : createUserMessageDocument({
            text: null,
            nonContentPart: {
              type: "automation",
              workflowName: payload.workflowName,
              ...(payload.workflowId === null
                ? {}
                : { workflowId: payload.workflowId }),
              ...(payload.triggerBrief === null
                ? {}
                : { automationBrief: payload.triggerBrief }),
            },
          }));
    if (!userMessage) {
      return false;
    }
    const rejected = await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "input.rejected",
      userMessage,
      runId: null,
      error: args.reason,
      automationId: payload.automationId,
      triggerSource: payload.triggerSource,
      triggerBrief: payload.triggerBrief,
    });
    return rejected !== null;
  });
}

export async function staleChatThreadQueueThreadIds(
  db: Db,
  args: {
    readonly staleBefore: Date;
    readonly limit: number;
  },
): Promise<readonly string[]> {
  return await staleChatEventQueueThreadIds(db, args);
}

/**
 * Minimal projection retained only for the previous frontend's queue API.
 * Current clients derive the same pending rows from canonical ChatEvents.
 */
export interface WorkflowQueueThreadRow {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly chatThreadId: string;
}

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
    })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.chatThreadId, args.threadId),
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
      ),
    )
    .limit(1);
  return row ? { ...row, chatThreadId: args.threadId } : null;
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
  readonly triggerSource: TriggerSource;
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
  const pending = await listPendingChatQueueEvents(db, thread.chatThreadId);
  const automationIds = pending.flatMap((event) => {
    return event.eventType === "input.automation" ? [event.id] : [];
  });
  if (automationIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      id: chatEvents.id,
      automationId: chatAutomationContext.automationId,
      triggerSource: chatEvents.triggerSource,
      triggerBrief: chatAutomationContext.triggerBrief,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .leftJoin(
      chatAutomationContext,
      and(
        eq(chatEvents.contextType, "automation"),
        eq(chatAutomationContext.id, chatEvents.contextId),
      ),
    )
    .where(inArray(chatEvents.id, automationIds));
  const byId = new Map(
    rows.flatMap((event) => {
      return event.automationId && event.triggerSource
        ? [
            [
              event.id,
              {
                ...event,
                automationId: event.automationId,
                triggerSource: event.triggerSource,
              },
            ] as const,
          ]
        : [];
    }),
  );
  return automationIds.flatMap((id) => {
    const event = byId.get(id);
    return event ? [event] : [];
  });
}

/** Append a canonical revoke for one previous-client queue Skip request. */
export async function deleteWorkflowQueueEventById(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly eventId: string;
  },
): Promise<{ readonly chatThreadId: string } | null> {
  return await db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ chatThreadId: chatEvents.chatThreadId })
      .from(chatEvents)
      .innerJoin(
        workflowUserAutomationThreads,
        eq(workflowUserAutomationThreads.chatThreadId, chatEvents.chatThreadId),
      )
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(workflowUserAutomationThreads.orgId, args.orgId),
          eq(workflowUserAutomationThreads.userId, args.userId),
        ),
      )
      .limit(1);
    if (!owned || !(await lockChatQueueThread(tx, owned.chatThreadId))) {
      return null;
    }
    const pending = await loadPendingChatQueueEvent(tx, {
      chatThreadId: owned.chatThreadId,
      eventId: args.eventId,
    });
    if (pending?.eventType !== "input.automation") {
      return null;
    }
    const revoked = await revokeChatEvent(tx, args.eventId, {
      chatThreadId: owned.chatThreadId,
      eventType: "control.revoke",
      runId: null,
    });
    return revoked ? { chatThreadId: owned.chatThreadId } : null;
  });
}

/**
 * Preserve previous-client Clear during the compatibility window by appending
 * canonical revokes. The current frontend exposes only single-event Skip.
 */
export async function clearWorkflowQueueEvents(
  db: Db,
  thread: WorkflowQueueThreadRow,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, thread.chatThreadId))) {
      return;
    }
    const pending = await listPendingChatQueueEvents(tx, thread.chatThreadId);
    for (const event of pending) {
      if (event.eventType !== "input.automation") {
        continue;
      }
      await revokeChatEvent(tx, event.id, {
        chatThreadId: thread.chatThreadId,
        eventType: "control.revoke",
        runId: null,
      });
    }
  });
}
