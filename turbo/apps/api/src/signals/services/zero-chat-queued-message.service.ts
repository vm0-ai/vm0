import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
  type ChatMessageStructuredPrompt,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, asc, eq, exists, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  pgNullDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import {
  deleteChatMessage,
  updateChatMessage,
} from "./zero-chat-message.service";
import { activeChatRunExists } from "./zero-chat-active-run.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import { feishuOrgCallbackFileSchema } from "./feishu-org-callback-payload";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const USER_MESSAGE_QUEUE_RUN_PARAMS_KEY = "__user_message_queue_run_params__";
const queuedUserMessageTriggerSourceDecoder = zodDriverValueDecoder(
  z.enum(["web", "slack", "feishu"]),
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
  apiStartTime: z.number().optional(),
  userInfoExtras: z
    .object({
      slackDisplayName: z.string().optional(),
      slackUserId: z.string().optional(),
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
] as const;

export interface QueuedUserMessage {
  readonly id: string;
  readonly content: string | null;
  readonly structuredPrompt: ChatMessageStructuredPrompt | null;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
  readonly triggerSource: "web" | "slack" | "feishu";
  readonly encryptedParams: string | null;
}

export interface QueueFirstRunAssociation {
  readonly threadId: string;
  readonly messageId: string;
}

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
): Promise<QueuedUserMessage | null> {
  const [message] = await db
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      structuredPrompt: chatMessages.structuredPrompt,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      generationTemplate: chatMessages.generationTemplate,
      modelProviderId: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderType: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderCredentialScope: sql`NULL`.mapWith(pgNullDecoder),
      selectedModel: chatThreads.selectedModel,
      triggerSource: sql`CASE
        WHEN ${chatMessageQueue.triggerSource} = 'slack' THEN 'slack'
        WHEN ${chatMessageQueue.triggerSource} = 'feishu' THEN 'feishu'
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
    .where(unclaimedQueuedUserMessageCondition(threadId))
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
    readonly triggerSource?: "web" | "slack" | "feishu";
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
      structuredPrompt: chatMessages.structuredPrompt,
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
        eq(chatMessages.role, "user"),
      ),
    )
    .for("update")
    .limit(1);
  if (!queued) {
    return null;
  }

  const claimed = await updateChatMessage(db, args.messageId, {
    chatThreadId: args.threadId,
    role: "user",
    content: queued.content,
    structuredPrompt: queued.structuredPrompt,
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

      if (await activeChatRunExists(db, { threadId: args.threadId })) {
        outcome = "lost";
        return { kind: "lost" };
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
    const tombstone = await deleteChatMessage(tx, args.messageId, {
      chatThreadId: args.threadId,
      role: "user",
      runId: null,
    });
    if (!tombstone) {
      throw new Error("Failed to append discarded user message tombstone");
    }
  });
}
