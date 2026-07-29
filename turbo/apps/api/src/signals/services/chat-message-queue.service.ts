import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroWorkflowAutomations } from "@vm0/db/schema/zero-workflow";
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Db } from "../external/db";
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
import { insertChatEvent, replaceChatEvent } from "./zero-chat-event.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { createUserMessageDocument } from "./zero-chat-user-message.service";

const WORKFLOW_QUEUE_EVENT_PARAMS_KEY = "__workflow_queue_event_params__";
const automationEventRevoker = alias(chatMessages, "automation_event_revoker");

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

function chatEventQueueAdmissionLock(chatThreadId: string) {
  // Keep the advisory namespace stable while API revisions overlap. This is
  // only a lock identifier; the contracted queue table is never accessed.
  const compatibilityKey = `chat_message_queue:${chatThreadId}`;
  return sql`SELECT pg_advisory_xact_lock(hashtext(${compatibilityKey}))`;
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
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.automationId, automationId),
        chatEventTypeIn(["input.automation"]),
        isNull(chatMessages.runId),
        notExists(
          db
            .select({ id: automationEventRevoker.id })
            .from(automationEventRevoker)
            .where(eq(automationEventRevoker.revokesEventId, chatMessages.id)),
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

export type WorkflowQueueAdmissionTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

export type PersistWorkflowQueueSourceTransition = (
  tx: WorkflowQueueAdmissionTransaction,
) => Promise<void>;

interface WorkflowQueueAdmissionArgs {
  readonly automation: typeof zeroWorkflowAutomations.$inferSelect;
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
    await tx.execute(chatEventQueueAdmissionLock(args.chatThreadId));

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
    await tx.execute(chatEventQueueAdmissionLock(chatThreadId));
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
        id: chatMessages.id,
        userId: chatThreads.userId,
        automationId: chatMessages.automationId,
        chatThreadId: chatMessages.chatThreadId,
        triggerSource: chatMessages.triggerSource,
        triggerBrief: chatMessages.triggerBrief,
        encryptedParams: chatMessages.encryptedParams,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
      .where(eq(chatMessages.id, head.id))
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
      automationId: chatMessages.automationId,
      triggerSource: chatMessages.triggerSource,
      triggerBrief: chatMessages.triggerBrief,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, eventId))
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
    const rejectionMessage = payload.triggerBrief ?? args.reason;
    const rejected = await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "input.rejected",
      userMessage: createUserMessageDocument({ text: rejectionMessage }),
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
