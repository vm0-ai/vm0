import { chatThreads } from "@vm0/db/schema/chat-thread";
import { teamsChatThreadRoutes } from "@vm0/db/schema/teams-chat-thread-route";
import { teamsOrgThreadSessions } from "@vm0/db/schema/teams-org-thread-session";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";

interface TeamsChatThreadRouteKey {
  readonly connectionId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly userId: string;
}

interface TeamsChatThreadRouteBinding extends TeamsChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
}

interface LoadedTeamsChatThreadRoute extends TeamsChatThreadRouteBinding {
  readonly agentComposeId: string;
  readonly selectedModel: string | null;
  readonly computerUseHostId: string | null;
}

type TeamsChatThreadTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

function routeWhere(key: TeamsChatThreadRouteKey) {
  return and(
    eq(teamsChatThreadRoutes.connectionId, key.connectionId),
    eq(teamsChatThreadRoutes.conversationId, key.conversationId),
    eq(teamsChatThreadRoutes.threadId, key.threadId),
    eq(teamsChatThreadRoutes.userId, key.userId),
  );
}

async function loadRoute(
  db: Pick<Db, "select">,
  key: TeamsChatThreadRouteKey,
): Promise<LoadedTeamsChatThreadRoute | undefined> {
  const [route] = await db
    .select({
      id: teamsChatThreadRoutes.id,
      connectionId: teamsChatThreadRoutes.connectionId,
      conversationId: teamsChatThreadRoutes.conversationId,
      threadId: teamsChatThreadRoutes.threadId,
      userId: teamsChatThreadRoutes.userId,
      chatThreadId: teamsChatThreadRoutes.chatThreadId,
      agentComposeId: chatThreads.agentComposeId,
      selectedModel: chatThreads.selectedModel,
      computerUseHostId: chatThreads.computerUseHostId,
    })
    .from(teamsChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
    )
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  return route;
}

async function loadLegacyThreadBinding(
  db: Pick<Db, "select">,
  key: TeamsChatThreadRouteKey,
) {
  const [binding] = await db
    .select({
      agentSessionId: teamsOrgThreadSessions.agentSessionId,
      computerUseHostId: teamsOrgThreadSessions.computerUseHostId,
    })
    .from(teamsOrgThreadSessions)
    .where(
      and(
        eq(teamsOrgThreadSessions.connectionId, key.connectionId),
        eq(teamsOrgThreadSessions.teamsConversationId, key.conversationId),
        eq(teamsOrgThreadSessions.teamsThreadId, key.threadId),
      ),
    )
    .limit(1);
  return binding;
}

async function createCanonicalTeamsChatThread(
  tx: TeamsChatThreadTransaction,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
  state: {
    readonly agentSessionId?: string | null;
    readonly computerUseHostId?: string | null;
  },
) {
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentComposeId: args.agentComposeId,
      agentSessionId: state.agentSessionId,
      computerUseHostId: state.computerUseHostId,
      selectedModel: args.selectedModel,
      title: null,
      lastReadAt: args.currentTime,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create canonical Teams chat thread");
  }
  return thread;
}

async function appendCanonicalTeamsChatThreadCreatedEvent(
  tx: TeamsChatThreadTransaction,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
  },
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

async function reconcileExistingRoute(
  tx: TeamsChatThreadTransaction,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
  existing: LoadedTeamsChatThreadRoute,
): Promise<TeamsChatThreadRouteBinding> {
  if (existing.agentComposeId !== args.agentComposeId) {
    const thread = await createCanonicalTeamsChatThread(tx, args, {
      computerUseHostId: existing.computerUseHostId,
    });
    const [route] = await tx
      .update(teamsChatThreadRoutes)
      .set({ chatThreadId: thread.id })
      .where(
        and(
          eq(teamsChatThreadRoutes.id, existing.id),
          eq(teamsChatThreadRoutes.chatThreadId, existing.chatThreadId),
        ),
      )
      .returning({
        id: teamsChatThreadRoutes.id,
        connectionId: teamsChatThreadRoutes.connectionId,
        conversationId: teamsChatThreadRoutes.conversationId,
        threadId: teamsChatThreadRoutes.threadId,
        userId: teamsChatThreadRoutes.userId,
        chatThreadId: teamsChatThreadRoutes.chatThreadId,
      });
    if (!route) {
      throw new Error("Failed to rebind Teams chat thread route");
    }
    await appendCanonicalTeamsChatThreadCreatedEvent(
      tx,
      args,
      thread,
      existing.computerUseHostId,
    );
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
      throw new Error("Failed to update canonical Teams chat thread model");
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

export async function ensureTeamsChatThreadRoute(
  db: Db,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
): Promise<TeamsChatThreadRouteBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      return await reconcileExistingRoute(tx, args, existing);
    }

    const legacyBinding = await loadLegacyThreadBinding(tx, args);
    const thread = await createCanonicalTeamsChatThread(tx, args, {
      agentSessionId: legacyBinding?.agentSessionId,
      computerUseHostId: legacyBinding?.computerUseHostId,
    });

    const [route] = await tx
      .insert(teamsChatThreadRoutes)
      .values({
        connectionId: args.connectionId,
        conversationId: args.conversationId,
        threadId: args.threadId,
        userId: args.userId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          teamsChatThreadRoutes.connectionId,
          teamsChatThreadRoutes.conversationId,
          teamsChatThreadRoutes.threadId,
          teamsChatThreadRoutes.userId,
        ],
      })
      .returning({
        id: teamsChatThreadRoutes.id,
        connectionId: teamsChatThreadRoutes.connectionId,
        conversationId: teamsChatThreadRoutes.conversationId,
        threadId: teamsChatThreadRoutes.threadId,
        userId: teamsChatThreadRoutes.userId,
        chatThreadId: teamsChatThreadRoutes.chatThreadId,
      });

    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const conflicted = await loadRoute(tx, args);
      if (!conflicted) {
        throw new Error(
          "Failed to resolve Teams chat thread route after conflict",
        );
      }
      return await reconcileExistingRoute(tx, args, conflicted);
    }

    await appendCanonicalTeamsChatThreadCreatedEvent(
      tx,
      args,
      thread,
      legacyBinding?.computerUseHostId,
    );
    return route;
  });
}
