import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import type { ChatEventType } from "@vm0/api-contracts/contracts/chat-events";
import { chatAutomationContext } from "@vm0/db/schema/chat-automation-context";
import { chatGoalContext } from "@vm0/db/schema/chat-goal-context";
import { chatEventInputParams } from "@vm0/db/schema/chat-event-input-params";
import {
  chatEvents,
  type ChatEventAttachFileMetadata,
  type ChatEventGenerationTemplate,
  type ChatEventUserMessage,
} from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
import {
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { and, eq, exists, isNull, notExists, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { pgNullDecoder } from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import {
  hasPendingUserChatQueueEvent,
  listPendingChatQueueEvents,
  loadPendingChatQueueEvent,
  lockChatQueueThread,
} from "./chat-event-queue.service";
import {
  insertChatEvent,
  revokeChatEvent,
  replaceChatEvent,
} from "./zero-chat-event.service";
import { touchChatThreadLastMessageAt } from "./zero-chat-event-shared.service";
import { chatThreadAdmissionBlocked } from "./zero-chat-active-run.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import { goalQueueEventMatchesActiveGoal } from "./chat-goal-queue.service";
import { feishuOrgCallbackFileSchema } from "./feishu-org-callback-payload";
import { agentphoneDeliveryTargetSchema } from "./agentphone-chat-callback-payload";
import { githubDeliveryTargetSchema } from "./github-chat-callback-payload";
import { teamsDeliveryTargetSchema } from "./teams-chat-callback-payload";
import { telegramDeliveryTargetSchema } from "./telegram-chat-callback-payload";
import { createUserMessageDocument } from "./zero-chat-user-message.service";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const USER_MESSAGE_QUEUE_RUN_PARAMS_KEY = "__user_message_queue_run_params__";
const queuedUserMessageTriggerSourceSchema = z.enum([
  "web",
  "slack",
  "feishu",
  "teams",
  "telegram",
  "agentphone",
  "github",
  "workflow-schedule",
]);

const queuedUserMessageRunParamsSchema = z.object({
  version: z.literal(1),
  prompt: z.string(),
  appendSystemPrompt: z.string(),
  realAgentInPreview: z.boolean().optional(),
  slackDelivery: z
    .object({
      channelId: z.string(),
      threadTs: z.string(),
      routeThreadTs: z.string().optional(),
    })
    .optional(),
  feishuDelivery: z
    .object({
      installationId: z.string(),
      connectionId: z.string(),
      chatId: z.string(),
      messageId: z.string(),
      threadId: z.string(),
      replyInThread: z.boolean(),
      reactionId: z.string().optional(),
      files: z.array(feishuOrgCallbackFileSchema).optional(),
    })
    .optional(),
  teamsDelivery: teamsDeliveryTargetSchema.optional(),
  telegramDelivery: telegramDeliveryTargetSchema.optional(),
  agentphoneDelivery: agentphoneDeliveryTargetSchema.optional(),
  githubDelivery: githubDeliveryTargetSchema.optional(),
  morningBriefDelivery: z
    .object({
      deliveryId: z.string(),
      internalKind: z.literal("morning-brief:email"),
      secret: z.string(),
      payload: z.unknown(),
    })
    .optional(),
  apiStartTime: z.number().optional(),
  userInfoExtras: z
    .object({
      slackDisplayName: z.string().optional(),
      slackUserId: z.string().optional(),
      feishuDisplayName: z.string().optional(),
      feishuOpenId: z.string().optional(),
      teamsUserDisplayName: z.string().optional(),
      teamsUserPrincipalName: z.string().optional(),
      teamsUserId: z.string().optional(),
      telegramDisplayName: z.string().optional(),
      telegramUsername: z.string().optional(),
      telegramUserId: z.string().optional(),
      telegramLanguage: z.string().optional(),
      agentphoneHandle: z.string().optional(),
    })
    .optional(),
});

type QueuedUserMessageRunParams = z.infer<
  typeof queuedUserMessageRunParamsSchema
>;

const queuedChatEvent = alias(chatEvents, "queued_chat_event");
const queuedChatEventRevoker = alias(chatEvents, "queued_chat_event_revoker");
const queuedEncryptedParams = chatEventInputParams.encryptedParams;
const queuedAttachFileMetadata = chatEventInputParams.attachFileMetadata;

export interface QueuedUserMessage {
  readonly id: string;
  readonly userMessage: ChatEventUserMessage;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatEventAttachFileMetadata[] | null;
  readonly generationTemplate: ChatEventGenerationTemplate | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
  readonly triggerSource:
    | "web"
    | "slack"
    | "feishu"
    | "teams"
    | "telegram"
    | "agentphone"
    | "github"
    | "workflow-schedule";
  readonly encryptedParams: string | null;
}

export type QueueFirstRunAssociation =
  | {
      readonly kind: "user_message";
      readonly threadId: string;
      readonly eventId: string;
      readonly morningBriefDeliveryId?: string;
    }
  | {
      readonly kind: "workflow_event";
      readonly threadId: string;
      readonly eventId: string;
      readonly prompt: string;
      readonly runGroupId: string;
    }
  | {
      readonly kind: "goal_event";
      readonly threadId: string;
      readonly eventId: string;
      readonly prompt: string;
      readonly goalId: string;
      readonly orgId: string;
      readonly userId: string;
    };

export type QueueFirstRunClaimResult =
  | {
      readonly kind: "claimed";
      readonly createdAt: Date;
      readonly morningBriefDeliveryId?: string;
    }
  | { readonly kind: "lost" };

export type QueueFirstRunAdmission =
  | { readonly kind: "blocked" }
  | { readonly kind: "idle" };

export type QueueFirstRunSessionSnapshotState =
  | "binding_changed"
  | "current"
  | "session_changed"
  | "unvalidated";

/**
 * Establish the thread-first lock order shared by every event-backed queue
 * claim, rejection, and revocation.
 */
export async function lockUserMessageQueueThread(
  db: Db,
  threadId: string,
): Promise<boolean> {
  return await lockChatQueueThread(db, threadId);
}

export async function encryptQueuedUserMessageRunParams(
  params: QueuedUserMessageRunParams,
  ctx: { readonly orgId: string; readonly userId: string },
): Promise<string> {
  const encrypted = await encryptPersistentSecretsMap(
    { [USER_MESSAGE_QUEUE_RUN_PARAMS_KEY]: JSON.stringify(params) },
    ctx,
  );
  if (!encrypted) {
    throw new Error("Failed to encrypt queued user message run params");
  }
  return encrypted;
}

export async function decryptQueuedUserMessageRunParams(
  encryptedParams: string | null,
  ctx: { readonly orgId: string; readonly userId: string },
): Promise<QueuedUserMessageRunParams | null> {
  if (!encryptedParams) {
    return null;
  }
  const decrypted = await decryptPersistentSecretsMap(encryptedParams, ctx);
  const raw = decrypted?.[USER_MESSAGE_QUEUE_RUN_PARAMS_KEY];
  if (!raw) {
    return null;
  }
  return queuedUserMessageRunParamsSchema.parse(JSON.parse(raw) as unknown);
}

/** Whether the outer ChatEvent row is an unclaimed, unrevoked prompt. */
export function queuedUserMessageExists(db: Pick<Db, "select">): SQL {
  return exists(
    db
      .select({ id: queuedChatEvent.id })
      .from(queuedChatEvent)
      .where(
        and(
          eq(queuedChatEvent.id, chatEvents.id),
          eq(queuedChatEvent.eventType, "input.prompt" satisfies ChatEventType),
          isNull(queuedChatEvent.runId),
          notExists(
            db
              .select({ id: queuedChatEventRevoker.id })
              .from(queuedChatEventRevoker)
              .where(
                eq(queuedChatEventRevoker.revokesEventId, queuedChatEvent.id),
              ),
          ),
        ),
      ),
  );
}

export async function loadNextUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
  queueItemCreatedBefore?: Date,
): Promise<QueuedUserMessage | null> {
  const pending = await listPendingChatQueueEvents(
    db,
    threadId,
    queueItemCreatedBefore,
  );
  const head = pending[0];
  if (!head || head.eventType !== "input.prompt") {
    return null;
  }
  const [event] = await db
    .select({
      id: chatEvents.id,
      userMessage: chatEvents.userMessage,
      attachFiles: chatEvents.attachFiles,
      attachFileMetadata: queuedAttachFileMetadata,
      generationTemplate: chatEvents.generationTemplate,
      modelProviderId: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderType: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderCredentialScope: sql`NULL`.mapWith(pgNullDecoder),
      selectedModel: chatThreads.selectedModel,
      triggerSource: chatEvents.triggerSource,
      encryptedParams: queuedEncryptedParams,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .where(
      and(
        eq(chatEvents.id, head.id),
        eq(chatEvents.chatThreadId, threadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatEvents.runId),
      ),
    )
    .limit(1);
  if (!event) {
    return null;
  }
  if (!event.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  const triggerSource = queuedUserMessageTriggerSourceSchema.safeParse(
    event.triggerSource,
  );
  // Legacy rows have no typed payload until the cutover migration backfills
  // them. They remain pending (and keep automation behind them) without making
  // a code-before-migration deploy fail.
  if (!triggerSource.success) {
    return null;
  }
  return {
    ...event,
    userMessage: event.userMessage,
    triggerSource: triggerSource.data,
  };
}

export async function loadNextUnclaimedQueuedUserMessageId(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const [head] = await listPendingChatQueueEvents(db, threadId);
  return head?.eventType === "input.prompt" ? head.id : null;
}

async function hasUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
): Promise<boolean> {
  return await hasPendingUserChatQueueEvent(db, threadId);
}

interface ClaimedUserMessage {
  readonly createdAt: Date;
}

/**
 * Append the run-associated replacement for a pending user event. The revoke
 * edge on the replacement is the atomic queue claim.
 */
async function appendClaimedUserMessage(
  db: DbTransaction,
  args: {
    readonly threadId: string;
    readonly eventId: string;
    readonly runId: string;
  },
): Promise<ClaimedUserMessage | null> {
  const pending = await loadPendingChatQueueEvent(db, {
    chatThreadId: args.threadId,
    eventId: args.eventId,
  });
  if (pending?.eventType !== "input.prompt") {
    return null;
  }
  const [queued] = await db
    .select({
      userMessage: chatEvents.userMessage,
      attachFiles: chatEvents.attachFiles,
      attachFileMetadata: queuedAttachFileMetadata,
      generationTemplate: chatEvents.generationTemplate,
      triggerSource: chatEvents.triggerSource,
    })
    .from(chatEvents)
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.threadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatEvents.runId),
      ),
    )
    .for("update", { of: chatEvents })
    .limit(1);
  if (!queued) {
    return null;
  }
  if (!queued.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }

  const claimed = await replaceChatEvent(db, args.eventId, {
    chatThreadId: args.threadId,
    eventType: "input.prompt",
    userMessage: queued.userMessage,
    runId: args.runId,
    attachFiles: queued.attachFiles ? [...queued.attachFiles] : null,
    attachFileMetadata: queued.attachFileMetadata
      ? [...queued.attachFileMetadata]
      : null,
    generationTemplate: queued.generationTemplate,
    ...(queued.triggerSource ? { triggerSource: queued.triggerSource } : {}),
  });
  if (!claimed) {
    return null;
  }
  return claimed;
}

type GoalQueueFirstRunAssociation = Extract<
  QueueFirstRunAssociation,
  { readonly kind: "goal_event" }
> & { readonly runId: string };
type WorkflowQueueFirstRunAssociation = Extract<
  QueueFirstRunAssociation,
  { readonly kind: "workflow_event" }
> & { readonly runId: string };

async function claimGoalQueueFirstRunAssociation(
  db: DbTransaction,
  args: GoalQueueFirstRunAssociation,
): Promise<QueueFirstRunClaimResult> {
  const pending = await listPendingChatQueueEvents(db, args.threadId);
  const goalMatches = await goalQueueEventMatchesActiveGoal(db, {
    chatThreadId: args.threadId,
    goalId: args.goalId,
    eventId: args.eventId,
    orgId: args.orgId,
    userId: args.userId,
  });
  const head = pending[0];
  if (
    head?.eventType !== "input.goal" ||
    head.id !== args.eventId ||
    !goalMatches
  ) {
    return { kind: "lost" };
  }

  const [goalEvent] = await db
    .select({
      userMessage: chatEvents.userMessage,
      goalBrief: chatGoalContext.objectiveBrief,
    })
    .from(chatEvents)
    .leftJoin(
      chatGoalContext,
      and(
        eq(chatEvents.contextType, "goal"),
        eq(chatGoalContext.id, chatEvents.contextId),
      ),
    )
    .where(eq(chatEvents.id, args.eventId))
    .limit(1);
  const userMessage =
    goalEvent?.userMessage ??
    (goalEvent?.goalBrief
      ? createUserMessageDocument({
          text: null,
          nonContentPart: {
            type: "goal",
            goalBrief: goalEvent.goalBrief,
          },
        })
      : null);
  if (!userMessage) {
    throw new Error("Goal queue event is missing its user message");
  }
  const claimed = await replaceChatEvent(db, args.eventId, {
    chatThreadId: args.threadId,
    eventType: "input.prompt",
    userMessage,
    runId: args.runId,
    runGroupId: args.goalId,
    triggerSource: "workflow-event",
  });
  if (!claimed) {
    throw new Error("Claimed goal queue event disappeared");
  }
  return { kind: "claimed", createdAt: claimed.createdAt };
}

async function claimWorkflowQueueFirstRunAssociation(
  db: DbTransaction,
  args: WorkflowQueueFirstRunAssociation,
): Promise<QueueFirstRunClaimResult> {
  if (await hasUnclaimedQueuedUserMessage(db, args.threadId)) {
    return { kind: "lost" };
  }

  const pending = await listPendingChatQueueEvents(db, args.threadId);
  const head = pending[0];
  const [automationEvent] = await db
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
    .where(eq(chatEvents.id, args.eventId))
    .limit(1);
  if (
    head?.eventType !== "input.automation" ||
    head.id !== args.eventId ||
    automationEvent?.automationId !== args.runGroupId
  ) {
    return { kind: "lost" };
  }

  const userMessage =
    automationEvent.userMessage ??
    (automationEvent.workflowName === null
      ? null
      : createUserMessageDocument({
          text: null,
          nonContentPart: {
            type: "automation",
            workflowName: automationEvent.workflowName,
            ...(automationEvent.workflowId === null
              ? {}
              : { workflowId: automationEvent.workflowId }),
            ...(automationEvent.triggerBrief === null
              ? {}
              : { automationBrief: automationEvent.triggerBrief }),
          },
        }));
  if (!userMessage) {
    throw new Error("Workflow queue event is missing its user message");
  }
  const claimed = await replaceChatEvent(db, args.eventId, {
    chatThreadId: args.threadId,
    eventType: "input.prompt",
    userMessage,
    runId: args.runId,
    runGroupId: args.runGroupId,
    ...(automationEvent.triggerSource
      ? { triggerSource: automationEvent.triggerSource }
      : {}),
  });
  if (!claimed) {
    throw new Error("Claimed workflow queue event disappeared");
  }
  return { kind: "claimed", createdAt: claimed.createdAt };
}

function queueFirstRunAdmissionBlocked(
  db: DbTransaction,
  args: { readonly apiStartTime: number; readonly threadId: string },
): Promise<boolean> {
  return chatThreadAdmissionBlocked(db, {
    threadId: args.threadId,
    apiStartTime: args.apiStartTime,
  });
}

/**
 * Resolve the transaction-scoped thread admission consumed by queue claim.
 * Successful launches hold the organization admission lock; failed launches
 * preserve their existing thread-only arbitration.
 */
export async function resolveQueueFirstRunAdmission(
  db: DbTransaction,
  args: {
    readonly apiStartTime: number;
    readonly sessionSnapshotState: QueueFirstRunSessionSnapshotState;
    readonly threadAlreadyLocked?: true;
    readonly threadId: string;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<QueueFirstRunAdmission> {
  let outcome: QueueFirstRunAdmission["kind"] | undefined;
  return await args.timing.measure(
    "api_dispatch_resolve_queue_first_admission",
    "nested",
    async () => {
      const threadExists =
        args.threadAlreadyLocked ??
        (await args.timing.measure(
          "api_dispatch_queue_first_thread_lock_wait",
          "nested",
          async () => {
            return await lockUserMessageQueueThread(db, args.threadId);
          },
        ));
      if (!threadExists) {
        outcome = "blocked";
        return { kind: "blocked" };
      }

      if (await queueFirstRunAdmissionBlocked(db, args)) {
        outcome = "blocked";
        return { kind: "blocked" };
      }

      outcome = "idle";
      return { kind: "idle" };
    },
    () => {
      return {
        ...(outcome ? { queue_first_admission_result: outcome } : {}),
        thread_session_snapshot_state: args.sessionSnapshotState,
      };
    },
  );
}

export async function claimQueueFirstRunAssociation(
  db: DbTransaction,
  args: QueueFirstRunAssociation & {
    readonly admission: QueueFirstRunAdmission;
    readonly runId: string;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<QueueFirstRunClaimResult> {
  let outcome: "claimed" | "lost" | "error" = "error";
  return await args.timing.measure(
    "api_dispatch_claim_queue_first_message",
    "nested",
    async () => {
      if (args.admission.kind === "blocked") {
        outcome = "lost";
        return { kind: "lost" };
      }

      if (args.kind === "goal_event") {
        const claim = await claimGoalQueueFirstRunAssociation(db, args);
        outcome = claim.kind;
        return claim;
      }

      if (args.kind === "workflow_event") {
        const claim = await claimWorkflowQueueFirstRunAssociation(db, args);
        outcome = claim.kind;
        return claim;
      }

      const headEventId = await loadNextUnclaimedQueuedUserMessageId(
        db,
        args.threadId,
      );
      if (headEventId !== args.eventId) {
        outcome = "lost";
        return { kind: "lost" };
      }

      if (
        !(await lockUnclaimedMorningBriefDelivery(
          db,
          args.morningBriefDeliveryId,
        ))
      ) {
        outcome = "lost";
        return { kind: "lost" };
      }

      const claimed = await appendClaimedUserMessage(db, {
        threadId: args.threadId,
        eventId: args.eventId,
        runId: args.runId,
      });
      if (!claimed) {
        outcome = "lost";
        return { kind: "lost" };
      }

      outcome = "claimed";
      return {
        kind: "claimed",
        createdAt: claimed.createdAt,
        ...(args.morningBriefDeliveryId
          ? { morningBriefDeliveryId: args.morningBriefDeliveryId }
          : {}),
      };
    },
    () => {
      return { queue_first_claim_result: outcome };
    },
  );
}

async function lockUnclaimedMorningBriefDelivery(
  db: DbTransaction,
  deliveryId: string | undefined,
): Promise<boolean> {
  if (!deliveryId) {
    return true;
  }
  const [delivery] = await db
    .select({ runId: morningBriefDeliveries.runId })
    .from(morningBriefDeliveries)
    .where(eq(morningBriefDeliveries.id, deliveryId))
    .for("update")
    .limit(1);
  return delivery?.runId === null;
}

/**
 * Finish queue-claim side effects that reference the newly inserted run row.
 * The caller invokes this in the same final-admission transaction immediately
 * after run persistence so the delivery foreign key and queue claim commit
 * atomically.
 */
export async function recordQueueFirstClaimedRun(
  db: DbTransaction,
  args: {
    readonly claim: Extract<
      QueueFirstRunClaimResult,
      { readonly kind: "claimed" }
    >;
    readonly runId: string;
  },
): Promise<void> {
  if (!args.claim.morningBriefDeliveryId) {
    return;
  }
  const [delivery] = await db
    .update(morningBriefDeliveries)
    .set({
      status: "running",
      runId: args.runId,
      updatedAt: sql`now()`,
    })
    .where(eq(morningBriefDeliveries.id, args.claim.morningBriefDeliveryId))
    .returning({ id: morningBriefDeliveries.id });
  if (!delivery) {
    throw new Error("Failed to record the admitted morning brief run");
  }
}

/**
 * A failed queue-first launch still owns the queue claim and run foreign key,
 * but must never make the Morning Brief delivery look active.
 */
export async function recordQueueFirstFailedRun(
  db: DbTransaction,
  args: {
    readonly claim: Extract<
      QueueFirstRunClaimResult,
      { readonly kind: "claimed" }
    >;
    readonly runId: string;
  },
): Promise<void> {
  if (!args.claim.morningBriefDeliveryId) {
    return;
  }
  const [delivery] = await db
    .update(morningBriefDeliveries)
    .set({
      status: "failed",
      runId: args.runId,
      updatedAt: sql`now()`,
    })
    .where(eq(morningBriefDeliveries.id, args.claim.morningBriefDeliveryId))
    .returning({ id: morningBriefDeliveries.id });
  if (!delivery) {
    throw new Error("Failed to record the failed morning brief run");
  }
}

/**
 * Discard a queue-first user message that never dispatched by appending a
 * tombstone. The revoke edge removes it from both queue and visible history.
 */
export async function discardUnclaimedUserMessageInTransaction(
  db: DbTransaction,
  args: {
    readonly threadId: string;
    readonly eventId: string;
  },
): Promise<boolean> {
  if (!(await lockUserMessageQueueThread(db, args.threadId))) {
    return false;
  }
  const pending = await loadPendingChatQueueEvent(db, {
    chatThreadId: args.threadId,
    eventId: args.eventId,
  });
  if (pending?.eventType !== "input.prompt") {
    return false;
  }
  const tombstone = await revokeChatEvent(db, args.eventId, {
    chatThreadId: args.threadId,
    eventType: "control.revoke",
    runId: null,
  });
  if (!tombstone) {
    throw new Error("Failed to append discarded user message tombstone");
  }
  return true;
}

export async function discardUnclaimedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly eventId: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await discardUnclaimedUserMessageInTransaction(tx, args);
  });
}

/**
 * Consume the current queue head without a run and append canonical user and
 * assistant replacements that explain a permanent integration admission
 * failure.
 */
export async function failQueuedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly eventId: string;
    readonly assistantContent: string;
    readonly errorMarker: string;
    readonly currentTime: Date;
  },
): Promise<{ readonly assistantEventId: string } | null> {
  return await db.transaction(async (tx) => {
    if (!(await lockUserMessageQueueThread(tx, args.threadId))) {
      return null;
    }
    if (
      (await loadNextUnclaimedQueuedUserMessageId(tx, args.threadId)) !==
      args.eventId
    ) {
      return null;
    }

    const [queued] = await tx
      .select({
        userMessage: chatEvents.userMessage,
        attachFiles: chatEvents.attachFiles,
        attachFileMetadata: queuedAttachFileMetadata,
        generationTemplate: chatEvents.generationTemplate,
      })
      .from(chatEvents)
      .leftJoin(
        chatEventInputParams,
        eq(chatEventInputParams.eventId, chatEvents.id),
      )
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
          chatEventTypeIn(["input.prompt"]),
          isNull(chatEvents.runId),
        ),
      )
      .for("update", { of: chatEvents })
      .limit(1);
    if (!queued) {
      return null;
    }
    if (!queued.userMessage) {
      throw new Error("Queued input event is missing userMessage");
    }

    const replacement = await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.threadId,
      eventType: "input.rejected",
      userMessage: queued.userMessage,
      attachFiles: queued.attachFiles ? [...queued.attachFiles] : null,
      attachFileMetadata: queued.attachFileMetadata
        ? [...queued.attachFileMetadata]
        : null,
      generationTemplate: queued.generationTemplate,
      runId: null,
      error: args.errorMarker,
      createdAt: args.currentTime,
    });
    if (!replacement) {
      return null;
    }

    const assistant = await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "output.error",
      content: args.assistantContent,
      runId: null,
      error: args.errorMarker,
      createdAt: new Date(args.currentTime.getTime() + 1),
    });
    if (!assistant) {
      throw new Error("Failed to append integration admission error");
    }
    await touchChatThreadLastMessageAt(tx, args.threadId, assistant.createdAt);
    return { assistantEventId: assistant.id };
  });
}
