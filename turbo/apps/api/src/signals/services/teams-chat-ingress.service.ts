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
): Promise<TeamsChatThreadRouteBinding | undefined> {
  const [route] = await db
    .select({
      id: teamsChatThreadRoutes.id,
      connectionId: teamsChatThreadRoutes.connectionId,
      conversationId: teamsChatThreadRoutes.conversationId,
      threadId: teamsChatThreadRoutes.threadId,
      userId: teamsChatThreadRoutes.userId,
      chatThreadId: teamsChatThreadRoutes.chatThreadId,
    })
    .from(teamsChatThreadRoutes)
    .where(routeWhere(key))
    .limit(1);
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
      return existing;
    }

    const legacyBinding = await loadLegacyThreadBinding(tx, args);
    const [thread] = await tx
      .insert(chatThreads)
      .values({
        userId: args.userId,
        agentComposeId: args.agentComposeId,
        agentSessionId: legacyBinding?.agentSessionId,
        computerUseHostId: legacyBinding?.computerUseHostId,
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
      return conflicted;
    }

    await appendChatThreadEvent(tx, {
      kind: "created",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: thread.id,
      agentComposeId: args.agentComposeId,
      title: null,
      selectedModel: args.selectedModel,
      computerUseHostId: legacyBinding?.computerUseHostId,
      createdAt: thread.createdAt,
    });
    return route;
  });
}
