import { v5 as uuidv5 } from "uuid";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { and, eq, isNull, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import {
  ensureTelegramChatThreadRoute,
  type TelegramChatThreadRouteOwner,
} from "./telegram-chat-ingress.service";
import { telegramDeliveryTargetSchema } from "./telegram-chat-callback-payload";
import { insertChatEvent } from "./zero-chat-event.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { touchChatThreadLastMessageAt } from "./zero-chat-message-shared.service";
import { encryptQueuedUserMessageRunParams } from "./zero-chat-queued-message.service";
import { createUserMessageDocument } from "./zero-chat-user-message.service";

const TELEGRAM_CHAT_MESSAGE_ID_NAMESPACE =
  "bb0f0a5a-807f-4ba8-bccb-8a4f12d9b5e9";
const telegramQueueEventRevoker = alias(
  chatMessages,
  "telegram_queue_event_revoker",
);

interface TelegramUserInfoExtras {
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
}

export async function admitTelegramChatMessage(args: {
  readonly db: Db;
  readonly owner: TelegramChatThreadRouteOwner;
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly agentId: string;
  readonly selectedModel: string | null;
  readonly installationId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly rootMessageId: string | undefined;
  readonly isDM: boolean;
  readonly displayText: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly userInfoExtras: TelegramUserInfoExtras;
  readonly apiStartTime: number;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly inserted: true;
      readonly chatThreadId: string;
      readonly chatMessageId: string;
    }
  | { readonly inserted: false }
> {
  const currentTime = new Date(args.apiStartTime);
  const route = await ensureTelegramChatThreadRoute(args.db, {
    chatId: args.chatId,
    rootMessageId: args.rootMessageId,
    messageId: args.messageId,
    owner: args.owner,
    userId: args.userId,
    orgId: args.orgId,
    agentComposeId: args.composeId,
    selectedModel: args.selectedModel,
    currentTime,
  });
  args.signal.throwIfAborted();

  const telegramDelivery = telegramDeliveryTargetSchema.parse({
    installationId: args.installationId,
    chatId: args.chatId,
    messageId: args.messageId,
    rootMessageId: args.rootMessageId ?? null,
    routeId: route.id,
    routeCreated: route.routeCreated,
    seededFromLegacy: route.seededFromLegacy,
    userLinkId: args.owner.userLinkId,
    userLinkKind: args.owner.userLinkKind,
    agentId: args.agentId,
    isDM: args.isDM,
  });
  const encryptedParams = await encryptQueuedUserMessageRunParams(
    {
      version: 1,
      prompt: args.prompt,
      appendSystemPrompt: args.appendSystemPrompt,
      telegramDelivery,
      apiStartTime: args.apiStartTime,
      userInfoExtras: args.userInfoExtras,
    },
    { orgId: args.orgId, userId: args.userId },
  );
  args.signal.throwIfAborted();

  const chatMessageId = uuidv5(
    [
      args.owner.userLinkKind,
      args.owner.userLinkId,
      args.chatId,
      args.messageId,
    ].join(":"),
    TELEGRAM_CHAT_MESSAGE_ID_NAMESPACE,
  );
  const inserted = await args.db.transaction(async (tx) => {
    const message = await insertChatEvent(
      tx,
      {
        id: chatMessageId,
        chatThreadId: route.chatThreadId,
        eventType: "input.prompt",
        content: args.displayText,
        userMessage: createUserMessageDocument({ text: args.displayText }),
        runId: null,
        triggerSource: "telegram",
        encryptedParams,
        createdAt: currentTime,
      },
      "id",
    );
    args.signal.throwIfAborted();
    if (!message) {
      return false;
    }
    await touchChatThreadLastMessageAt(
      tx,
      route.chatThreadId,
      currentTime,
      chatMessageId,
    );
    return true;
  });
  args.signal.throwIfAborted();
  return inserted
    ? {
        inserted: true,
        chatThreadId: route.chatThreadId,
        chatMessageId,
      }
    : { inserted: false };
}

export async function telegramChatMessageIsQueued(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly chatMessageId: string;
  },
): Promise<boolean> {
  const [[unclaimed], [run]] = await Promise.all([
    db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, args.chatMessageId),
          eq(chatMessages.chatThreadId, args.chatThreadId),
          chatEventTypeIn(["input.prompt"]),
          isNull(chatMessages.runId),
          notExists(
            db
              .select({ id: telegramQueueEventRevoker.id })
              .from(telegramQueueEventRevoker)
              .where(
                eq(telegramQueueEventRevoker.revokesEventId, chatMessages.id),
              ),
          ),
        ),
      )
      .limit(1),
    db
      .select({ status: agentRuns.status })
      .from(chatMessages)
      .innerJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
      .where(
        and(
          eq(chatMessages.chatThreadId, args.chatThreadId),
          or(
            eq(chatMessages.id, args.chatMessageId),
            eq(chatMessages.revokesEventId, args.chatMessageId),
          ),
        ),
      )
      .limit(1),
  ]);
  return Boolean(unclaimed) || run?.status === "queued";
}
