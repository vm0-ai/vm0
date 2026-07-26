import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  slackChatIngress,
  type SlackChatIngressStatus,
} from "@vm0/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@vm0/db/schema/slack-chat-thread-route";
import { and, eq, isNull, sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";

// Drizzle includes every declared table column in INSERT statements, even when
// omitted values resolve to DEFAULT. Keep this receiver projection limited to
// the columns that survive the next contract migration so the deployed API
// remains compatible before and after legacy route columns are dropped.
const slackChatThreadRouteReceiver = pgTable("slack_chat_thread_routes", {
  id: uuid("id").defaultRandom().primaryKey(),
  connectionId: uuid("connection_id").notNull(),
  channelId: varchar("channel_id", { length: 255 }).notNull(),
  threadTs: varchar("thread_ts", { length: 255 }).notNull(),
  userId: text("user_id").notNull(),
  chatThreadId: uuid("chat_thread_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

interface SlackChatThreadRouteKey {
  readonly connectionId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly userId: string;
}

interface SlackChatThreadRouteBinding extends SlackChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string | null;
}

interface CanonicalSlackChatThreadRouteBinding extends SlackChatThreadRouteBinding {
  readonly chatThreadId: string;
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

function requireCanonicalSlackChatThreadRoute(
  route: SlackChatThreadRouteBinding,
): CanonicalSlackChatThreadRouteBinding {
  if (!route.chatThreadId) {
    throw new Error("Failed to resolve canonical Slack chat thread route");
  }
  return {
    ...route,
    chatThreadId: route.chatThreadId,
  };
}

export async function ensureCanonicalSlackChatThreadRoute(
  db: Db,
  args: SlackChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentComposeId: string;
    readonly selectedModel: string | null;
    readonly currentTime: Date;
  },
): Promise<CanonicalSlackChatThreadRouteBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadSlackChatThreadRoute(tx, args);
    if (existing?.chatThreadId) {
      return requireCanonicalSlackChatThreadRoute(existing);
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

    const routeReturning = {
      id: slackChatThreadRoutes.id,
      connectionId: slackChatThreadRoutes.connectionId,
      channelId: slackChatThreadRoutes.channelId,
      threadTs: slackChatThreadRoutes.threadTs,
      userId: slackChatThreadRoutes.userId,
      chatThreadId: slackChatThreadRoutes.chatThreadId,
    };
    const receiverReturning = {
      id: slackChatThreadRouteReceiver.id,
      connectionId: slackChatThreadRouteReceiver.connectionId,
      channelId: slackChatThreadRouteReceiver.channelId,
      threadTs: slackChatThreadRouteReceiver.threadTs,
      userId: slackChatThreadRouteReceiver.userId,
      chatThreadId: slackChatThreadRouteReceiver.chatThreadId,
    };
    const [route] = existing
      ? await tx
          .update(slackChatThreadRoutes)
          .set({
            chatThreadId: thread.id,
          })
          .where(
            and(
              eq(slackChatThreadRoutes.id, existing.id),
              isNull(slackChatThreadRoutes.chatThreadId),
            ),
          )
          .returning(routeReturning)
      : await tx
          .insert(slackChatThreadRouteReceiver)
          .values({
            connectionId: args.connectionId,
            channelId: args.channelId,
            threadTs: args.threadTs,
            userId: args.userId,
            chatThreadId: thread.id,
            createdAt: args.currentTime,
          })
          .onConflictDoNothing({
            target: [
              slackChatThreadRouteReceiver.connectionId,
              slackChatThreadRouteReceiver.channelId,
              slackChatThreadRouteReceiver.threadTs,
              slackChatThreadRouteReceiver.userId,
            ],
          })
          .returning(receiverReturning);

    if (!route) {
      const [promoted] = await tx
        .update(slackChatThreadRoutes)
        .set({
          chatThreadId: thread.id,
        })
        .where(
          and(
            slackChatThreadRouteWhere(args),
            isNull(slackChatThreadRoutes.chatThreadId),
          ),
        )
        .returning(routeReturning);
      if (promoted) {
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
        return requireCanonicalSlackChatThreadRoute(promoted);
      }

      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      return requireCanonicalSlackChatThreadRoute(
        await requireSlackChatThreadRoute(tx, args),
      );
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
    return requireCanonicalSlackChatThreadRoute(route);
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
