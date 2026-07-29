import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import type { ChatEventType } from "@vm0/api-contracts/contracts/chat-events";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
  type ChatMessageUserMessage,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
import { and, eq, exists, isNull, notExists, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { pgNullDecoder } from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import {
  hasPendingUserChatQueueEvent,
  listPendingChatQueueEvents,
  loadChatAutomationIntakePause,
  loadPendingChatQueueEvent,
  lockChatQueueThread,
} from "./chat-event-queue.service";
import {
  insertChatEvent,
  revokeChatEvent,
  replaceChatEvent,
} from "./zero-chat-event.service";
import { touchChatThreadLastMessageAt } from "./zero-chat-message-shared.service";
import { chatThreadAdmissionBlocked } from "./zero-chat-active-run.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import { goalQueueEventMatchesActiveGoal } from "./chat-goal-queue.service";
import { feishuOrgCallbackFileSchema } from "./feishu-org-callback-payload";
import { teamsDeliveryTargetSchema } from "./teams-chat-callback-payload";
import { createUserMessageDocument } from "./zero-chat-user-message.service";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const USER_MESSAGE_QUEUE_RUN_PARAMS_KEY = "__user_message_queue_run_params__";
const queuedUserMessageTriggerSourceSchema = z.enum([
  "web",
  "slack",
  "feishu",
  "teams",
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
    })
    .optional(),
});

type QueuedUserMessageRunParams = z.infer<
  typeof queuedUserMessageRunParamsSchema
>;

const queuedChatMessage = alias(chatMessages, "queued_chat_message");
const queuedChatMessageRevoker = alias(
  chatMessages,
  "queued_chat_message_revoker",
);

export interface QueuedUserMessage {
  readonly id: string;
  readonly content: string | null;
  readonly userMessage: ChatMessageUserMessage;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
  readonly triggerSource:
    | "web"
    | "slack"
    | "feishu"
    | "teams"
    | "workflow-schedule";
  readonly encryptedParams: string | null;
}

export type QueueFirstRunAssociation =
  | {
      readonly kind: "user_message";
      readonly threadId: string;
      readonly messageId: string;
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
      readonly objectiveBrief: string;
    };

export type QueueFirstRunClaimResult =
  | {
      readonly kind: "claimed";
      readonly createdAt: Date;
      readonly morningBriefDeliveryId?: string;
    }
  | { readonly kind: "lost" };

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

/** Whether the outer chat_messages row is an unclaimed, unrevoked prompt. */
export function queuedUserMessageExists(db: Pick<Db, "select">): SQL {
  return exists(
    db
      .select({ id: queuedChatMessage.id })
      .from(queuedChatMessage)
      .where(
        and(
          eq(queuedChatMessage.id, chatMessages.id),
          eq(
            queuedChatMessage.eventType,
            "input.prompt" satisfies ChatEventType,
          ),
          isNull(queuedChatMessage.runId),
          notExists(
            db
              .select({ id: queuedChatMessageRevoker.id })
              .from(queuedChatMessageRevoker)
              .where(
                eq(
                  queuedChatMessageRevoker.revokesEventId,
                  queuedChatMessage.id,
                ),
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
  const [message] = await db
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      userMessage: chatMessages.userMessage,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      generationTemplate: chatMessages.generationTemplate,
      modelProviderId: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderType: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderCredentialScope: sql`NULL`.mapWith(pgNullDecoder),
      selectedModel: chatThreads.selectedModel,
      triggerSource: chatMessages.triggerSource,
      encryptedParams: chatMessages.encryptedParams,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .where(
      and(
        eq(chatMessages.id, head.id),
        eq(chatMessages.chatThreadId, threadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatMessages.runId),
      ),
    )
    .limit(1);
  if (!message) {
    return null;
  }
  if (!message.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  const triggerSource = queuedUserMessageTriggerSourceSchema.safeParse(
    message.triggerSource,
  );
  // Legacy rows have no typed payload until the cutover migration backfills
  // them. They remain pending (and keep automation behind them) without making
  // a code-before-migration deploy fail.
  if (!triggerSource.success) {
    return null;
  }
  return {
    ...message,
    userMessage: message.userMessage,
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
    readonly messageId: string;
    readonly runId: string;
  },
): Promise<ClaimedUserMessage | null> {
  const pending = await loadPendingChatQueueEvent(db, {
    chatThreadId: args.threadId,
    eventId: args.messageId,
  });
  if (pending?.eventType !== "input.prompt") {
    return null;
  }
  const [queued] = await db
    .select({
      content: chatMessages.content,
      userMessage: chatMessages.userMessage,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      generationTemplate: chatMessages.generationTemplate,
      triggerSource: chatMessages.triggerSource,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, args.messageId),
        eq(chatMessages.chatThreadId, args.threadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatMessages.runId),
      ),
    )
    .for("update")
    .limit(1);
  if (!queued) {
    return null;
  }
  if (!queued.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }

  const claimed = await replaceChatEvent(db, args.messageId, {
    chatThreadId: args.threadId,
    eventType: "input.prompt",
    content: queued.content,
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

async function claimGoalQueueFirstRunAssociation(
  db: DbTransaction,
  args: GoalQueueFirstRunAssociation,
): Promise<QueueFirstRunClaimResult> {
  const pending = await listPendingChatQueueEvents(db, args.threadId);
  const automationPause = await loadChatAutomationIntakePause(
    db,
    args.threadId,
  );
  const goalMatches = await goalQueueEventMatchesActiveGoal(db, {
    chatThreadId: args.threadId,
    goalId: args.goalId,
    eventId: args.eventId,
    orgId: args.orgId,
    userId: args.userId,
  });
  const head =
    automationPause === null
      ? pending[0]
      : pending.find((event) => {
          return event.eventType !== "input.automation";
        });
  if (
    head?.eventType !== "input.goal" ||
    head.id !== args.eventId ||
    !goalMatches
  ) {
    return { kind: "lost" };
  }

  const claimed = await replaceChatEvent(db, args.eventId, {
    chatThreadId: args.threadId,
    eventType: "input.prompt",
    content: args.prompt,
    userMessage: createUserMessageDocument({ text: args.prompt }),
    runId: args.runId,
    runGroupId: args.goalId,
    goalSnapshot: { objectiveBrief: args.objectiveBrief },
    triggerSource: "workflow-event",
  });
  if (!claimed) {
    throw new Error("Claimed goal queue event disappeared");
  }
  return { kind: "claimed", createdAt: claimed.createdAt };
}

/**
 * Authoritatively arbitrate a queue-first launch inside its final persistence
 * transaction. Successful launches acquire the organization admission lock
 * first; failed launches do not acquire that lock or create active state.
 */
export async function claimQueueFirstRunAssociation(
  db: DbTransaction,
  args: QueueFirstRunAssociation & {
    readonly runId: string;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<QueueFirstRunClaimResult> {
  let outcome: "claimed" | "lost" | "error" = "error";
  return await args.timing.measure(
    "api_dispatch_claim_queue_first_message",
    "nested",
    async () => {
      const threadExists = await args.timing.measure(
        "api_dispatch_queue_first_thread_lock_wait",
        "nested",
        async () => {
          return await lockUserMessageQueueThread(db, args.threadId);
        },
      );
      if (!threadExists) {
        outcome = "lost";
        return { kind: "lost" };
      }

      if (await chatThreadAdmissionBlocked(db, { threadId: args.threadId })) {
        outcome = "lost";
        return { kind: "lost" };
      }

      if (args.kind === "goal_event") {
        const claim = await claimGoalQueueFirstRunAssociation(db, args);
        outcome = claim.kind;
        return claim;
      }

      if (args.kind === "workflow_event") {
        if (
          (await loadChatAutomationIntakePause(db, args.threadId)) ||
          (await hasUnclaimedQueuedUserMessage(db, args.threadId))
        ) {
          outcome = "lost";
          return { kind: "lost" };
        }

        const pending = await listPendingChatQueueEvents(db, args.threadId);
        const head = pending[0];
        const [automationEvent] = await db
          .select({
            automationId: chatMessages.automationId,
            triggerSource: chatMessages.triggerSource,
          })
          .from(chatMessages)
          .where(eq(chatMessages.id, args.eventId))
          .limit(1);
        if (
          head?.eventType !== "input.automation" ||
          head?.id !== args.eventId ||
          automationEvent?.automationId !== args.runGroupId
        ) {
          outcome = "lost";
          return { kind: "lost" };
        }

        const claimed = await replaceChatEvent(db, args.eventId, {
          chatThreadId: args.threadId,
          eventType: "input.prompt",
          content: args.prompt,
          userMessage: createUserMessageDocument({ text: args.prompt }),
          runId: args.runId,
          runGroupId: args.runGroupId,
          ...(automationEvent.triggerSource
            ? { triggerSource: automationEvent.triggerSource }
            : {}),
        });
        if (!claimed) {
          throw new Error("Claimed workflow queue event disappeared");
        }

        outcome = "claimed";
        return { kind: "claimed", createdAt: claimed.createdAt };
      }

      const headMessageId = await loadNextUnclaimedQueuedUserMessageId(
        db,
        args.threadId,
      );
      if (headMessageId !== args.messageId) {
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
        messageId: args.messageId,
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
    readonly messageId: string;
  },
): Promise<boolean> {
  if (!(await lockUserMessageQueueThread(db, args.threadId))) {
    return false;
  }
  const pending = await loadPendingChatQueueEvent(db, {
    chatThreadId: args.threadId,
    eventId: args.messageId,
  });
  if (pending?.eventType !== "input.prompt") {
    return false;
  }
  const tombstone = await revokeChatEvent(db, args.messageId, {
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
    readonly messageId: string;
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
    readonly messageId: string;
    readonly assistantContent: string;
    readonly errorMarker: string;
    readonly currentTime: Date;
  },
): Promise<{ readonly assistantMessageId: string } | null> {
  return await db.transaction(async (tx) => {
    if (!(await lockUserMessageQueueThread(tx, args.threadId))) {
      return null;
    }
    if (
      (await loadNextUnclaimedQueuedUserMessageId(tx, args.threadId)) !==
      args.messageId
    ) {
      return null;
    }

    const [queued] = await tx
      .select({
        content: chatMessages.content,
        userMessage: chatMessages.userMessage,
        attachFiles: chatMessages.attachFiles,
        attachFileMetadata: chatMessages.attachFileMetadata,
        generationTemplate: chatMessages.generationTemplate,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, args.messageId),
          eq(chatMessages.chatThreadId, args.threadId),
          chatEventTypeIn(["input.prompt"]),
          isNull(chatMessages.runId),
        ),
      )
      .for("update")
      .limit(1);
    if (!queued) {
      return null;
    }
    if (!queued.userMessage) {
      throw new Error("Queued input event is missing userMessage");
    }

    const replacement = await replaceChatEvent(tx, args.messageId, {
      chatThreadId: args.threadId,
      eventType: "input.rejected",
      content: queued.content,
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
    return { assistantMessageId: assistant.id };
  });
}
