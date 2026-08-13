import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { zeroRuns } from "@okouai/db/schema/zero-run";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import {
  hasPendingUserChatQueueEvent,
  listPendingChatQueueEvents,
  loadPendingChatQueueEvent,
  lockChatQueueThread,
  staleChatEventQueueThreadIds,
} from "./chat-event-queue.service";
import { insertChatEvent, replaceChatEvent } from "./zero-chat-event.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import {
  createUserMessageDocument,
  withAgentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
} from "./zero-chat-user-message.service";
import type {
  WorkflowAutomationEventPayload,
  WorkflowAutomationEventType,
} from "./workflow-automation-context.service";
import type { Tx } from "../../lib/db-types";
import { manualTriggerSource } from "./workflow-automation-trigger-source";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";

const automationEventRevoker = alias(chatEvents, "automation_event_revoker");

export type WorkflowQueueAdmissionTransaction = Tx;

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

export type PersistWorkflowQueueSourceTransition = (
  tx: WorkflowQueueAdmissionTransaction,
) => Promise<void>;

interface WorkflowQueueAdmissionArgs {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly workflowName: string;
  readonly displayPrompt: string;
  readonly agentRunSource?: ChatAgentRunSourceAnnotation;
  readonly workflowAutomationEventType?: WorkflowAutomationEventType;
  readonly workflowAutomationEventPayload?: WorkflowAutomationEventPayload;
  readonly chatThreadId: string;
  readonly triggerSource: TriggerSource;
  readonly triggerBrief: string | undefined;
  readonly coalescePendingScheduleRun: boolean;
  /**
   * Atomically transitions a provider-owned source event only after its
   * workflow queue item has been inserted. Throwing rolls back both writes.
   */
  readonly persistSourceTransition?: PersistWorkflowQueueSourceTransition;
}

async function attemptWorkflowQueueAdmission(
  db: Db,
  args: WorkflowQueueAdmissionArgs,
): Promise<WorkflowQueueAdmission> {
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

    const automationUserMessage = createUserMessageDocument({
      text: args.displayPrompt,
      nonContentPart: {
        type: "automation",
        workflowName: args.workflowName,
        workflowId: automation.workflowId,
        ...(args.triggerBrief === undefined
          ? {}
          : { automationBrief: args.triggerBrief }),
      },
    });
    const userMessage = args.agentRunSource
      ? withAgentRunSourceAnnotation(automationUserMessage, args.agentRunSource)
      : automationUserMessage;
    const inserted = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.automation",
      content: null,
      userMessage,
      runId: null,
      automationId: automation.id,
      workflowName: args.workflowName,
      workflowAutomationEventType: args.workflowAutomationEventType,
      workflowAutomationEventPayload: args.workflowAutomationEventPayload,
      triggerBrief: args.triggerBrief ?? null,
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
  return await attemptWorkflowQueueAdmission(db, args);
}

export interface PendingWorkflowQueueEvent {
  readonly id: string;
  readonly userId: string;
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly triggerSource: TriggerSource;
  readonly triggerBrief: string | null;
  readonly workflowName: string | null;
  readonly workflowAutomationEventType: string | null;
  readonly workflowAutomationEventPayload: WorkflowAutomationEventPayload | null;
}

/**
 * Load the runnable automation head. Pending user events always win and any
 * active run blocks the whole thread.
 *
 * A concurrently deleted thread can remove the selected event before this
 * lookup; that canonical deletion race returns null rather than failing.
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
        automationKind: workflowAutomations.kind,
        chatThreadId: chatEvents.chatThreadId,
        triggerBrief: chatAutomationContext.triggerBrief,
        workflowName: chatAutomationContext.workflowName,
        workflowAutomationEventType: chatAutomationContext.eventType,
        workflowAutomationEventPayload: chatAutomationContext.eventPayload,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .leftJoin(
        chatAutomationContext,
        and(
          eq(chatEvents.contextType, "automation"),
          eq(chatAutomationContext.id, chatEvents.contextId),
        ),
      )
      .leftJoin(
        workflowAutomations,
        eq(workflowAutomations.id, chatAutomationContext.automationId),
      )
      .where(eq(chatEvents.id, head.id))
      .limit(1);
    if (!event) {
      return null;
    }
    if (!event.automationId || !event.automationKind) {
      throw new Error(
        `Workflow queue event ${event.id} is missing its typed payload`,
      );
    }
    return {
      ...event,
      automationId: event.automationId,
      triggerSource: manualTriggerSource({ kind: event.automationKind }),
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
      automationKind: workflowAutomations.kind,
      triggerBrief: chatAutomationContext.triggerBrief,
      userMessage: canonicalChatEventUserMessage(),
      workflowId: workflows.id,
      workflowName: workflows.name,
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
      workflowAutomations,
      eq(workflowAutomations.id, chatAutomationContext.automationId),
    )
    .leftJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
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
    if (!payload?.automationId || !payload.automationKind) {
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
    readonly chatThreadIds?: readonly string[];
  },
): Promise<readonly string[]> {
  return await staleChatEventQueueThreadIds(db, args);
}
