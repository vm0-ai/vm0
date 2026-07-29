import { chatThreads } from "@vm0/db/schema/chat-thread";
import { telegramChatThreadRoutes } from "@vm0/db/schema/telegram-chat-thread-route";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";

export type TelegramChatThreadRouteOwner =
  | {
      readonly userLinkKind: "custom";
      readonly userLinkId: string;
    }
  | {
      readonly userLinkKind: "official";
      readonly userLinkId: string;
    };

interface TelegramChatThreadRouteKey {
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly owner: TelegramChatThreadRouteOwner;
}

interface TelegramChatThreadRouteBinding {
  readonly id: string;
  readonly chatThreadId: string;
  readonly rootMessageId: string;
  readonly lastProcessedMessageId: string | null;
}

interface EnsuredTelegramChatThreadRoute extends TelegramChatThreadRouteBinding {
  readonly routeCreated: boolean;
  readonly seededFromLegacy: boolean;
}

interface LoadedTelegramChatThreadRoute extends TelegramChatThreadRouteBinding {
  readonly agentComposeId: string;
  readonly selectedModel: string | null;
}

type TelegramChatThreadTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

function ownerWhere(owner: TelegramChatThreadRouteOwner) {
  return owner.userLinkKind === "custom"
    ? eq(telegramChatThreadRoutes.telegramUserLinkId, owner.userLinkId)
    : eq(telegramChatThreadRoutes.telegramOfficialUserLinkId, owner.userLinkId);
}

function routeWhere(key: TelegramChatThreadRouteKey) {
  return and(
    ownerWhere(key.owner),
    eq(telegramChatThreadRoutes.chatId, key.chatId),
    eq(telegramChatThreadRoutes.rootMessageId, key.rootMessageId),
  );
}

async function loadRoute(
  db: Pick<Db, "select">,
  key: TelegramChatThreadRouteKey,
): Promise<LoadedTelegramChatThreadRoute | undefined> {
  const [route] = await db
    .select({
      id: telegramChatThreadRoutes.id,
      chatThreadId: telegramChatThreadRoutes.chatThreadId,
      rootMessageId: telegramChatThreadRoutes.rootMessageId,
      lastProcessedMessageId: telegramChatThreadRoutes.lastProcessedMessageId,
      agentComposeId: chatThreads.agentComposeId,
      selectedModel: chatThreads.selectedModel,
    })
    .from(telegramChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, telegramChatThreadRoutes.chatThreadId),
    )
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  return route;
}

async function loadLegacyBinding(
  db: Pick<Db, "select">,
  key: TelegramChatThreadRouteKey,
) {
  const [binding] = await db
    .select({
      agentSessionId: telegramThreadSessions.agentSessionId,
      lastProcessedMessageId: telegramThreadSessions.lastProcessedMessageId,
    })
    .from(telegramThreadSessions)
    .where(
      and(
        key.owner.userLinkKind === "custom"
          ? eq(telegramThreadSessions.telegramUserLinkId, key.owner.userLinkId)
          : eq(
              telegramThreadSessions.telegramOfficialUserLinkId,
              key.owner.userLinkId,
            ),
        eq(telegramThreadSessions.chatId, key.chatId),
        eq(telegramThreadSessions.rootMessageId, key.rootMessageId),
      ),
    )
    .limit(1);
  return binding;
}

async function createCanonicalTelegramChatThread(
  tx: TelegramChatThreadTransaction,
  args: TelegramChatThreadRouteKey & {
    readonly userId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
  agentSessionId?: string | null,
) {
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentComposeId: args.agentComposeId,
      agentSessionId,
      selectedModel: args.selectedModel,
      title: null,
      lastReadAt: args.currentTime,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create canonical Telegram chat thread");
  }
  return thread;
}

async function appendCreatedEvent(
  tx: TelegramChatThreadTransaction,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
  },
  thread: { readonly id: string; readonly createdAt: Date },
): Promise<void> {
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentComposeId: args.agentComposeId,
    title: null,
    selectedModel: args.selectedModel,
    computerUseHostId: null,
    createdAt: thread.createdAt,
  });
}

async function reconcileExistingRoute(
  tx: TelegramChatThreadTransaction,
  args: TelegramChatThreadRouteKey & {
    readonly userId: string;
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
  existing: LoadedTelegramChatThreadRoute,
): Promise<TelegramChatThreadRouteBinding> {
  if (existing.agentComposeId !== args.agentComposeId) {
    const thread = await createCanonicalTelegramChatThread(tx, args);
    const [route] = await tx
      .update(telegramChatThreadRoutes)
      .set({ chatThreadId: thread.id, updatedAt: args.currentTime })
      .where(
        and(
          eq(telegramChatThreadRoutes.id, existing.id),
          eq(telegramChatThreadRoutes.chatThreadId, existing.chatThreadId),
        ),
      )
      .returning({
        id: telegramChatThreadRoutes.id,
        chatThreadId: telegramChatThreadRoutes.chatThreadId,
        rootMessageId: telegramChatThreadRoutes.rootMessageId,
        lastProcessedMessageId: telegramChatThreadRoutes.lastProcessedMessageId,
      });
    if (!route) {
      throw new Error("Failed to rebind Telegram chat thread route");
    }
    await appendCreatedEvent(tx, args, thread);
    return route;
  }

  if (existing.selectedModel !== args.selectedModel) {
    const [thread] = await tx
      .update(chatThreads)
      .set({
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: args.selectedModel,
        updatedAt: args.currentTime,
      })
      .where(eq(chatThreads.id, existing.chatThreadId))
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Failed to update canonical Telegram thread model");
    }
    await appendChatThreadEvent(tx, {
      kind: "model_selection_updated",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: existing.chatThreadId,
      agentComposeId: existing.agentComposeId,
      selectedModel: args.selectedModel,
      createdAt: args.currentTime,
    });
  }
  return existing;
}

export async function ensureTelegramChatThreadRoute(
  db: Db,
  args: {
    readonly chatId: string;
    readonly rootMessageId: string | undefined;
    readonly messageId: string;
    readonly owner: TelegramChatThreadRouteOwner;
    readonly userId: string;
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
): Promise<EnsuredTelegramChatThreadRoute> {
  const key: TelegramChatThreadRouteKey = {
    chatId: args.chatId,
    rootMessageId: args.rootMessageId ?? `pending:${args.messageId}`,
    owner: args.owner,
  };
  const routeArgs = { ...args, rootMessageId: key.rootMessageId };
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, key);
    if (existing) {
      return {
        ...(await reconcileExistingRoute(tx, routeArgs, existing)),
        routeCreated: false,
        seededFromLegacy: false,
      };
    }

    const legacy = args.rootMessageId
      ? await loadLegacyBinding(tx, key)
      : undefined;
    const thread = await createCanonicalTelegramChatThread(
      tx,
      routeArgs,
      legacy?.agentSessionId,
    );
    const [route] = await tx
      .insert(telegramChatThreadRoutes)
      .values({
        telegramUserLinkId:
          args.owner.userLinkKind === "custom" ? args.owner.userLinkId : null,
        telegramOfficialUserLinkId:
          args.owner.userLinkKind === "official" ? args.owner.userLinkId : null,
        chatId: args.chatId,
        rootMessageId: key.rootMessageId,
        chatThreadId: thread.id,
        lastProcessedMessageId: legacy?.lastProcessedMessageId,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoNothing()
      .returning({
        id: telegramChatThreadRoutes.id,
        chatThreadId: telegramChatThreadRoutes.chatThreadId,
        rootMessageId: telegramChatThreadRoutes.rootMessageId,
        lastProcessedMessageId: telegramChatThreadRoutes.lastProcessedMessageId,
      });
    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const conflicted = await loadRoute(tx, key);
      if (!conflicted) {
        throw new Error(
          "Failed to resolve Telegram chat thread route after conflict",
        );
      }
      return {
        ...(await reconcileExistingRoute(tx, routeArgs, conflicted)),
        routeCreated: false,
        seededFromLegacy: false,
      };
    }
    await appendCreatedEvent(tx, routeArgs, thread);
    return {
      ...route,
      routeCreated: true,
      seededFromLegacy: Boolean(legacy),
    };
  });
}
