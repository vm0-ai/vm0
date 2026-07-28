import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
  type ChatMessageStructuredPrompt,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, asc, eq, exists, inArray, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  pgNullDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import type { Db } from "../external/db";
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
import { feishuOrgCallbackFileSchema } from "./feishu-org-callback-payload";
import { teamsDeliveryTargetSchema } from "./teams-chat-callback-payload";
import { effectiveChatMessageStructuredPrompt } from "./zero-chat-structured-message-storage.service";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const USER_MESSAGE_QUEUE_RUN_PARAMS_KEY = "__user_message_queue_run_params__";
const queuedUserMessageTriggerSourceDecoder = zodDriverValueDecoder(
  z.enum(["web", "slack", "feishu", "teams"]),
);

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

const queuedUserMessageItemTypes = [
  "user_message",
  "slack_user_message",
  "feishu_user_message",
  "teams_user_message",
] as const;

export interface QueuedUserMessage {
  readonly id: string;
  readonly content: string | null;
  readonly structuredPrompt: ChatMessageStructuredPrompt | null;
  readonly structuredPromptWithFeedback: ChatMessageStructuredPrompt | null;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
  readonly triggerSource: "web" | "slack" | "feishu" | "teams";
  readonly encryptedParams: string | null;
}

export type QueueFirstRunAssociation =
  | {
      readonly kind: "user_message";
      readonly threadId: string;
      readonly messageId: string;
    }
  | {
      readonly kind: "workflow_event";
      readonly threadId: string;
      readonly eventId: string;
      readonly prompt: string;
      readonly runGroupId: string;
    };

export type QueueFirstRunClaimResult =
  | { readonly kind: "claimed"; readonly createdAt: Date }
  | { readonly kind: "lost" };

/**
 * Establish the thread-first lock order shared by every user-message queue
 * consumer before it locks or deletes a queue row.
 */
export async function lockUserMessageQueueThread(
  db: Db,
  threadId: string,
): Promise<boolean> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .for("update");
  return thread !== undefined;
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

function unclaimedQueuedUserMessageCondition(
  threadId: string,
): SQL | undefined {
  return and(
    eq(chatMessageQueue.chatThreadId, threadId),
    inArray(chatMessageQueue.itemType, queuedUserMessageItemTypes),
  );
}

/** Whether the outer chat_messages row is waiting in the user-message queue. */
export function queuedUserMessageExists(db: Pick<Db, "select">): SQL {
  return exists(
    db
      .select({ id: chatMessageQueue.id })
      .from(chatMessageQueue)
      .where(
        and(
          inArray(chatMessageQueue.itemType, queuedUserMessageItemTypes),
          eq(chatMessageQueue.chatMessageId, chatMessages.id),
        ),
      ),
  );
}

export async function loadNextUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
  queueItemCreatedBefore?: Date,
): Promise<QueuedUserMessage | null> {
  const [message] = await db
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      structuredPrompt: effectiveChatMessageStructuredPrompt(),
      structuredPromptWithFeedback: chatMessages.structuredPromptWithFeedback,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      generationTemplate: chatMessages.generationTemplate,
      modelProviderId: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderType: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderCredentialScope: sql`NULL`.mapWith(pgNullDecoder),
      selectedModel: chatThreads.selectedModel,
      triggerSource: sql`CASE
        WHEN ${eq(chatMessageQueue.triggerSource, sql`'slack'`)} THEN 'slack'
        WHEN ${eq(chatMessageQueue.triggerSource, sql`'feishu'`)} THEN 'feishu'
        WHEN ${eq(chatMessageQueue.triggerSource, sql`'teams'`)} THEN 'teams'
        ELSE 'web'
      END`.mapWith(queuedUserMessageTriggerSourceDecoder),
      encryptedParams: chatMessageQueue.encryptedParams,
    })
    .from(chatMessageQueue)
    .innerJoin(
      chatMessages,
      eq(chatMessages.id, chatMessageQueue.chatMessageId),
    )
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .where(
      and(
        unclaimedQueuedUserMessageCondition(threadId),
        queueItemCreatedBefore
          ? lt(chatMessageQueue.createdAt, queueItemCreatedBefore)
          : undefined,
      ),
    )
    .orderBy(asc(chatMessageQueue.createdAt), asc(chatMessageQueue.id))
    .limit(1);

  return message ?? null;
}

export async function loadNextUnclaimedQueuedUserMessageId(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const [message] = await db
    .select({ id: chatMessages.id })
    .from(chatMessageQueue)
    .innerJoin(
      chatMessages,
      eq(chatMessages.id, chatMessageQueue.chatMessageId),
    )
    .where(unclaimedQueuedUserMessageCondition(threadId))
    .orderBy(asc(chatMessageQueue.createdAt), asc(chatMessageQueue.id))
    .limit(1);

  return message?.id ?? null;
}

export async function hasUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
): Promise<boolean> {
  const [item] = await db
    .select({ id: chatMessageQueue.id })
    .from(chatMessageQueue)
    .where(unclaimedQueuedUserMessageCondition(threadId))
    .limit(1);

  return item !== undefined;
}

/** Persist the queue pointer used by the shared per-thread scheduler. */
export async function enqueueUserMessageQueueItem(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly chatMessageId: string;
    readonly triggerSource?: "web" | "slack" | "feishu" | "teams";
    readonly encryptedParams?: string;
  },
): Promise<void> {
  await db
    .insert(chatMessageQueue)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      chatThreadId: args.chatThreadId,
      itemType:
        args.triggerSource === "slack"
          ? "slack_user_message"
          : args.triggerSource === "feishu"
            ? "feishu_user_message"
            : args.triggerSource === "teams"
              ? "teams_user_message"
              : "user_message",
      chatMessageId: args.chatMessageId,
      triggerSource: args.triggerSource,
      encryptedParams: args.encryptedParams,
    })
    .onConflictDoNothing();
}

export async function deleteUserMessageQueueItem(
  db: Db,
  args: {
    readonly threadId: string;
    readonly messageId: string;
  },
): Promise<boolean> {
  const deleted = await db
    .delete(chatMessageQueue)
    .where(
      and(
        inArray(chatMessageQueue.itemType, queuedUserMessageItemTypes),
        eq(chatMessageQueue.chatThreadId, args.threadId),
        eq(chatMessageQueue.chatMessageId, args.messageId),
      ),
    )
    .returning({ id: chatMessageQueue.id });
  return deleted.length > 0;
}

interface ClaimedUserMessage {
  readonly createdAt: Date;
}

/**
 * Append the run-associated replacement for a queued user message and consume
 * its queue item. Callers serialize dispatch decisions before invoking this.
 */
async function appendClaimedUserMessage(
  db: DbTransaction,
  args: {
    readonly threadId: string;
    readonly messageId: string;
    readonly runId: string;
  },
): Promise<ClaimedUserMessage | null> {
  const [queued] = await db
    .select({
      content: chatMessages.content,
      structuredPrompt: effectiveChatMessageStructuredPrompt(),
      structuredPromptWithFeedback: chatMessages.structuredPromptWithFeedback,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      generationTemplate: chatMessages.generationTemplate,
    })
    .from(chatMessageQueue)
    .innerJoin(
      chatMessages,
      eq(chatMessages.id, chatMessageQueue.chatMessageId),
    )
    .where(
      and(
        inArray(chatMessageQueue.itemType, queuedUserMessageItemTypes),
        eq(chatMessageQueue.chatMessageId, args.messageId),
        eq(chatMessageQueue.chatThreadId, args.threadId),
        eq(chatMessages.chatThreadId, args.threadId),
        chatEventTypeIn(["input.prompt"]),
      ),
    )
    .for("update")
    .limit(1);
  if (!queued) {
    return null;
  }

  const claimed = await replaceChatEvent(db, args.messageId, {
    chatThreadId: args.threadId,
    eventType: "input.prompt",
    content: queued.content,
    structuredPrompt: queued.structuredPrompt,
    structuredPromptWithFeedback: queued.structuredPromptWithFeedback,
    runId: args.runId,
    attachFiles: queued.attachFiles ? [...queued.attachFiles] : null,
    attachFileMetadata: queued.attachFileMetadata
      ? [...queued.attachFileMetadata]
      : null,
    generationTemplate: queued.generationTemplate,
  });
  if (!claimed) {
    return null;
  }
  if (
    !(await deleteUserMessageQueueItem(db, {
      threadId: args.threadId,
      messageId: args.messageId,
    }))
  ) {
    throw new Error("Claimed user message queue item disappeared");
  }
  return claimed;
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

      if (args.kind === "workflow_event") {
        const [thread] = await db
          .select({ queuePausedAt: chatThreads.queuePausedAt })
          .from(chatThreads)
          .where(eq(chatThreads.id, args.threadId))
          .limit(1);
        if (
          thread?.queuePausedAt ||
          (await hasUnclaimedQueuedUserMessage(db, args.threadId))
        ) {
          outcome = "lost";
          return { kind: "lost" };
        }

        const [head] = await db
          .select({
            id: chatMessageQueue.id,
            automationId: chatMessageQueue.automationId,
          })
          .from(chatMessageQueue)
          .where(
            and(
              eq(chatMessageQueue.chatThreadId, args.threadId),
              eq(chatMessageQueue.itemType, "workflow_event"),
            ),
          )
          .orderBy(asc(chatMessageQueue.createdAt), asc(chatMessageQueue.id))
          .limit(1);
        if (
          head?.id !== args.eventId ||
          head.automationId !== args.runGroupId
        ) {
          outcome = "lost";
          return { kind: "lost" };
        }

        const claimed = await insertChatEvent(db, {
          chatThreadId: args.threadId,
          eventType: "input.prompt",
          content: args.prompt,
          runId: args.runId,
          runGroupId: args.runGroupId,
        });
        const deleted = await db
          .delete(chatMessageQueue)
          .where(
            and(
              eq(chatMessageQueue.id, args.eventId),
              eq(chatMessageQueue.chatThreadId, args.threadId),
              eq(chatMessageQueue.itemType, "workflow_event"),
            ),
          )
          .returning({ id: chatMessageQueue.id });
        if (!claimed || deleted.length !== 1) {
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
      return { kind: "claimed", createdAt: claimed.createdAt };
    },
    () => {
      return { queue_first_claim_result: outcome };
    },
  );
}

/**
 * Discard a queue-first user message that never dispatched (run creation
 * failed): consume the queue item and append a tombstone so the failed send is
 * absent from the visible thread while the message stream stays append-only.
 */
export async function discardUnclaimedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly messageId: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await lockUserMessageQueueThread(tx, args.threadId))) {
      return;
    }
    const queueItemDeleted = await deleteUserMessageQueueItem(tx, {
      threadId: args.threadId,
      messageId: args.messageId,
    });
    if (!queueItemDeleted) {
      return;
    }
    const tombstone = await revokeChatEvent(tx, args.messageId, {
      chatThreadId: args.threadId,
      eventType: "control.revoke",
      runId: null,
    });
    if (!tombstone) {
      throw new Error("Failed to append discarded user message tombstone");
    }
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
        structuredPrompt: effectiveChatMessageStructuredPrompt(),
        structuredPromptWithFeedback: chatMessages.structuredPromptWithFeedback,
        attachFiles: chatMessages.attachFiles,
        attachFileMetadata: chatMessages.attachFileMetadata,
        generationTemplate: chatMessages.generationTemplate,
      })
      .from(chatMessageQueue)
      .innerJoin(
        chatMessages,
        eq(chatMessages.id, chatMessageQueue.chatMessageId),
      )
      .where(
        and(
          inArray(chatMessageQueue.itemType, queuedUserMessageItemTypes),
          eq(chatMessageQueue.chatThreadId, args.threadId),
          eq(chatMessageQueue.chatMessageId, args.messageId),
          eq(chatMessages.chatThreadId, args.threadId),
          chatEventTypeIn(["input.prompt"]),
        ),
      )
      .for("update")
      .limit(1);
    if (!queued) {
      return null;
    }

    const replacement = await replaceChatEvent(tx, args.messageId, {
      chatThreadId: args.threadId,
      eventType: "input.rejected",
      content: queued.content,
      structuredPrompt: queued.structuredPrompt,
      structuredPromptWithFeedback: queued.structuredPromptWithFeedback,
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
    if (
      !(await deleteUserMessageQueueItem(tx, {
        threadId: args.threadId,
        messageId: args.messageId,
      }))
    ) {
      throw new Error("Failed integration queue item disappeared");
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
