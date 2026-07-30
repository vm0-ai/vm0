import { agentphoneChatThreadRoutes } from "@vm0/db/schema/agentphone-chat-thread-route";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";

interface AgentPhoneChatThreadRouteKey {
  readonly agentphoneUserLinkId: string;
  readonly rootMessageId: string;
}

interface AgentPhoneChatThreadBinding {
  readonly chatThreadId: string;
}

interface LoadedAgentPhoneChatThreadRoute extends AgentPhoneChatThreadBinding {
  readonly id: string;
  readonly conversationId: string | null;
  readonly agentComposeId: string;
  readonly selectedModel: string | null;
  readonly computerUseHostId: string | null;
}

interface AgentPhoneChatThreadCreateArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentComposeId: string;
  readonly selectedModel: string | null;
  readonly conversationId: string | null;
  readonly currentTime: Date;
}

type AgentPhoneChatThreadTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

function routeWhere(key: AgentPhoneChatThreadRouteKey) {
  return and(
    eq(
      agentphoneChatThreadRoutes.agentphoneUserLinkId,
      key.agentphoneUserLinkId,
    ),
    eq(agentphoneChatThreadRoutes.rootMessageId, key.rootMessageId),
  );
}

async function loadRoute(
  db: Pick<Db, "select">,
  key: AgentPhoneChatThreadRouteKey,
): Promise<LoadedAgentPhoneChatThreadRoute | undefined> {
  const [route] = await db
    .select({
      id: agentphoneChatThreadRoutes.id,
      conversationId: agentphoneChatThreadRoutes.conversationId,
      chatThreadId: agentphoneChatThreadRoutes.chatThreadId,
      agentComposeId: chatThreads.agentComposeId,
      selectedModel: chatThreads.selectedModel,
      computerUseHostId: chatThreads.computerUseHostId,
    })
    .from(agentphoneChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, agentphoneChatThreadRoutes.chatThreadId),
    )
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  return route;
}

async function createCanonicalAgentPhoneChatThread(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadCreateArgs,
  computerUseHostId: string | null = null,
) {
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentComposeId: args.agentComposeId,
      computerUseHostId,
      selectedModel: args.selectedModel,
      title: null,
      lastReadAt: args.currentTime,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create canonical AgentPhone chat thread");
  }
  return thread;
}

async function appendCanonicalAgentPhoneChatThreadCreatedEvent(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadCreateArgs,
  thread: { readonly id: string; readonly createdAt: Date },
  computerUseHostId: string | null | undefined,
): Promise<void> {
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentComposeId: args.agentComposeId,
    title: null,
    selectedModel: args.selectedModel,
    computerUseHostId,
    createdAt: thread.createdAt,
  });
}

async function updateRouteConversationContext(
  tx: AgentPhoneChatThreadTransaction,
  route: LoadedAgentPhoneChatThreadRoute,
  conversationId: string | null,
): Promise<void> {
  if (route.conversationId === conversationId) {
    return;
  }
  await tx
    .update(agentphoneChatThreadRoutes)
    .set({ conversationId })
    .where(eq(agentphoneChatThreadRoutes.id, route.id));
}

async function reconcileExistingRoute(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadRouteKey & AgentPhoneChatThreadCreateArgs,
  existing: LoadedAgentPhoneChatThreadRoute,
): Promise<AgentPhoneChatThreadBinding> {
  if (existing.agentComposeId !== args.agentComposeId) {
    const thread = await createCanonicalAgentPhoneChatThread(
      tx,
      args,
      existing.computerUseHostId,
    );
    const [route] = await tx
      .update(agentphoneChatThreadRoutes)
      .set({
        chatThreadId: thread.id,
        conversationId: args.conversationId,
      })
      .where(
        and(
          eq(agentphoneChatThreadRoutes.id, existing.id),
          eq(agentphoneChatThreadRoutes.chatThreadId, existing.chatThreadId),
        ),
      )
      .returning({ chatThreadId: agentphoneChatThreadRoutes.chatThreadId });
    if (!route) {
      throw new Error("Failed to rebind AgentPhone chat thread route");
    }
    await appendCanonicalAgentPhoneChatThreadCreatedEvent(
      tx,
      args,
      thread,
      existing.computerUseHostId,
    );
    return route;
  }

  await updateRouteConversationContext(tx, existing, args.conversationId);
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
      throw new Error("Failed to update canonical AgentPhone thread model");
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

export async function ensureAgentPhoneChatThreadRoute(
  db: Db,
  args: AgentPhoneChatThreadRouteKey & AgentPhoneChatThreadCreateArgs,
): Promise<AgentPhoneChatThreadBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      return await reconcileExistingRoute(tx, args, existing);
    }

    const thread = await createCanonicalAgentPhoneChatThread(tx, args);
    const [route] = await tx
      .insert(agentphoneChatThreadRoutes)
      .values({
        agentphoneUserLinkId: args.agentphoneUserLinkId,
        rootMessageId: args.rootMessageId,
        conversationId: args.conversationId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          agentphoneChatThreadRoutes.agentphoneUserLinkId,
          agentphoneChatThreadRoutes.rootMessageId,
        ],
      })
      .returning({ chatThreadId: agentphoneChatThreadRoutes.chatThreadId });
    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const conflicted = await loadRoute(tx, args);
      if (!conflicted) {
        throw new Error(
          "Failed to resolve AgentPhone chat thread route after conflict",
        );
      }
      return await reconcileExistingRoute(tx, args, conflicted);
    }

    await appendCanonicalAgentPhoneChatThreadCreatedEvent(
      tx,
      args,
      thread,
      null,
    );
    return route;
  });
}
