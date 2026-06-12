import { command } from "ccstate";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { chatThreadMarkReadContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { notFound } from "../../lib/error";
import { visibleChatMessageCondition } from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route";

const markReadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkReadContract.markRead));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  const [thread] = await writeDb
    .select({
      lastReadAt: chatThreads.lastReadAt,
      lastReadMessageId: chatThreads.lastReadMessageId,
      lastMessageAt: chatThreads.lastMessageAt,
    })
    .from(chatThreads)
    .where(
      and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!thread) {
    return notFound("Chat thread not found");
  }

  const [latestText] = await writeDb
    .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, params.id),
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.content),
        sql`${chatMessages.content} <> ''`,
        visibleChatMessageCondition(),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1);
  signal.throwIfAborted();

  if (!latestText) {
    return {
      status: 200 as const,
      body: {
        lastReadMessageId: null,
        lastReadAt: thread.lastReadAt?.toISOString() ?? null,
        changed: false,
      },
    };
  }

  const nextReadAtMs = Math.max(
    thread.lastMessageAt.getTime(),
    latestText.createdAt.getTime(),
  );
  const currentLastReadAt = thread.lastReadAt;
  if (
    currentLastReadAt !== null &&
    currentLastReadAt.getTime() >= nextReadAtMs &&
    thread.lastReadMessageId === latestText.id
  ) {
    return {
      status: 200 as const,
      body: {
        lastReadMessageId: latestText.id,
        lastReadAt: currentLastReadAt.toISOString(),
        changed: false,
      },
    };
  }

  const [updated] = await writeDb
    .update(chatThreads)
    .set({
      lastReadAt: sql`GREATEST(
        COALESCE(${chatThreads.lastReadAt}, 'epoch'::timestamp),
        ${chatThreads.lastMessageAt},
        ${latestText.createdAt}
      )`,
      lastReadMessageId: latestText.id,
    })
    .where(
      and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
    )
    .returning({ lastReadAt: chatThreads.lastReadAt });
  signal.throwIfAborted();
  const lastReadAt = updated?.lastReadAt ?? new Date(nextReadAtMs);

  await publishUserSignal(
    [auth.userId],
    `chatThreadReadCursorUpdated:${params.id}`,
    { lastReadMessageId: latestText.id, lastReadAt: lastReadAt.toISOString() },
  );
  signal.throwIfAborted();
  await publishThreadListChanged(auth.userId);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      lastReadMessageId: latestText.id,
      lastReadAt: lastReadAt.toISOString(),
      changed: true,
    },
  };
});

export const zeroChatThreadMarkReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkReadContract.markRead,
    handler: authRoute({}, markReadInner$),
  },
];
