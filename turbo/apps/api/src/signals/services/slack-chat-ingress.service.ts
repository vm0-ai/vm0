import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  slackChatIngress,
  type SlackChatIngressStatus,
} from "@vm0/db/schema/slack-chat-ingress";
import {
  slackChatThreadRoutes,
  type SlackChatThreadRouteBackend,
} from "@vm0/db/schema/slack-chat-thread-route";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";

interface SlackChatThreadRouteKey {
  readonly connectionId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly userId: string;
}

interface SlackChatThreadRouteBinding extends SlackChatThreadRouteKey {
  readonly id: string;
  readonly backend: SlackChatThreadRouteBackend;
  readonly chatThreadId: string | null;
}

function slackChatThreadRouteWhere(key: SlackChatThreadRouteKey) {
  return and(
    eq(slackChatThreadRoutes.connectionId, key.connectionId),
    eq(slackChatThreadRoutes.channelId, key.channelId),
    eq(slackChatThreadRoutes.threadTs, key.threadTs),
    eq(slackChatThreadRoutes.userId, key.userId),
  );
}

async function loadSlackChatThreadRoute(
  db: Pick<Db, "select">,
  key: SlackChatThreadRouteKey,
): Promise<SlackChatThreadRouteBinding | undefined> {
  const [route] = await db
    .select({
      id: slackChatThreadRoutes.id,
      connectionId: slackChatThreadRoutes.connectionId,
      channelId: slackChatThreadRoutes.channelId,
      threadTs: slackChatThreadRoutes.threadTs,
      userId: slackChatThreadRoutes.userId,
      backend: slackChatThreadRoutes.backend,
      chatThreadId: slackChatThreadRoutes.chatThreadId,
    })
    .from(slackChatThreadRoutes)
    .where(slackChatThreadRouteWhere(key))
    .limit(1);
  return route;
}

export async function findSlackChatThreadRoute(
  db: Db,
  key: SlackChatThreadRouteKey,
): Promise<SlackChatThreadRouteBinding | undefined> {
  return await loadSlackChatThreadRoute(db, key);
}

async function requireSlackChatThreadRoute(
  db: Pick<Db, "select">,
  key: SlackChatThreadRouteKey,
): Promise<SlackChatThreadRouteBinding> {
  const route = await loadSlackChatThreadRoute(db, key);
  if (!route) {
    throw new Error("Failed to resolve Slack chat thread route after conflict");
  }
  return route;
}

export async function ensureLegacySlackChatThreadRoute(
  db: Db,
  args: SlackChatThreadRouteKey & { readonly currentTime: Date },
): Promise<SlackChatThreadRouteBinding> {
  const [route] = await db
    .insert(slackChatThreadRoutes)
    .values({
      connectionId: args.connectionId,
      channelId: args.channelId,
      threadTs: args.threadTs,
      userId: args.userId,
      backend: "legacy",
      chatThreadId: null,
      createdAt: args.currentTime,
    })
    .onConflictDoNothing({
      target: [
        slackChatThreadRoutes.connectionId,
        slackChatThreadRoutes.channelId,
        slackChatThreadRoutes.threadTs,
        slackChatThreadRoutes.userId,
      ],
    })
    .returning({
      id: slackChatThreadRoutes.id,
      connectionId: slackChatThreadRoutes.connectionId,
      channelId: slackChatThreadRoutes.channelId,
      threadTs: slackChatThreadRoutes.threadTs,
      userId: slackChatThreadRoutes.userId,
      backend: slackChatThreadRoutes.backend,
      chatThreadId: slackChatThreadRoutes.chatThreadId,
    });
  return route ?? (await requireSlackChatThreadRoute(db, args));
}

export async function ensureCanonicalSlackChatThreadRoute(
  db: Db,
  args: SlackChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
): Promise<SlackChatThreadRouteBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadSlackChatThreadRoute(tx, args);
    if (existing) {
      return existing;
    }

    const [thread] = await tx
      .insert(chatThreads)
      .values({
        userId: args.userId,
        agentComposeId: args.agentComposeId,
        selectedModel: args.selectedModel,
        title: null,
        lastReadAt: args.currentTime,
        lastMessageAt: args.currentTime,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
    if (!thread) {
      throw new Error("Failed to create canonical Slack chat thread");
    }

    const [route] = await tx
      .insert(slackChatThreadRoutes)
      .values({
        connectionId: args.connectionId,
        channelId: args.channelId,
        threadTs: args.threadTs,
        userId: args.userId,
        backend: "canonical",
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          slackChatThreadRoutes.connectionId,
          slackChatThreadRoutes.channelId,
          slackChatThreadRoutes.threadTs,
          slackChatThreadRoutes.userId,
        ],
      })
      .returning({
        id: slackChatThreadRoutes.id,
        connectionId: slackChatThreadRoutes.connectionId,
        channelId: slackChatThreadRoutes.channelId,
        threadTs: slackChatThreadRoutes.threadTs,
        userId: slackChatThreadRoutes.userId,
        backend: slackChatThreadRoutes.backend,
        chatThreadId: slackChatThreadRoutes.chatThreadId,
      });

    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      return await requireSlackChatThreadRoute(tx, args);
    }

    await appendChatThreadEvent(tx, {
      kind: "created",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: thread.id,
      agentComposeId: args.agentComposeId,
      title: null,
      selectedModel: args.selectedModel,
      createdAt: thread.createdAt,
    });
    return route;
  });
}

interface SlackChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: SlackChatIngressStatus;
  readonly retryCount: number;
}

export async function admitCanonicalSlackChatEvent(
  db: Db,
  args: {
    readonly routeId: string;
    readonly eventId: string;
    readonly payload: string;
    readonly isRetry: boolean;
    readonly currentTime: Date;
  },
): Promise<SlackChatIngressAdmission> {
  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(slackChatIngress)
      .values({
        routeId: args.routeId,
        eventId: args.eventId,
        payload: args.payload,
        status: "pending",
        retryCount: args.isRetry ? 1 : 0,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoNothing({ target: slackChatIngress.eventId })
      .returning({
        id: slackChatIngress.id,
        routeId: slackChatIngress.routeId,
        status: slackChatIngress.status,
        retryCount: slackChatIngress.retryCount,
      });
    if (inserted) {
      return { ...inserted, inserted: true };
    }

    const [existing] = await tx
      .select({
        id: slackChatIngress.id,
        routeId: slackChatIngress.routeId,
        status: slackChatIngress.status,
        retryCount: slackChatIngress.retryCount,
      })
      .from(slackChatIngress)
      .where(eq(slackChatIngress.eventId, args.eventId))
      .limit(1);
    if (!existing) {
      throw new Error("Failed to resolve canonical Slack ingress event");
    }
    if (existing.routeId !== args.routeId) {
      throw new Error("Slack event ID is already bound to another route");
    }
    if (!args.isRetry) {
      return { ...existing, inserted: false };
    }

    const [retried] = await tx
      .update(slackChatIngress)
      .set({
        retryCount: sql`${slackChatIngress.retryCount} + 1`,
        updatedAt: args.currentTime,
      })
      .where(eq(slackChatIngress.id, existing.id))
      .returning({
        id: slackChatIngress.id,
        status: slackChatIngress.status,
        retryCount: slackChatIngress.retryCount,
      });
    if (!retried) {
      throw new Error("Failed to record canonical Slack ingress retry");
    }
    return { ...retried, inserted: false };
  });
}
