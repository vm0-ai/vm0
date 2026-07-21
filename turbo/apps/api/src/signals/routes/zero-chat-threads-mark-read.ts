import { command } from "ccstate";
import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { chatThreadMarkReadContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { notFound } from "../../lib/error";
import { zeroChatThreadUnreads } from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route-entry";

function latestRunFinishCreatedAtSql() {
  return sql`(
    SELECT ${chatMessages.createdAt}
    FROM ${chatMessages}
    WHERE ${chatMessages.chatThreadId} = ${chatThreads.id}
      AND ${chatMessages.runLifecycleEvent} IS NOT NULL
    ORDER BY ${chatMessages.createdAt} DESC, ${chatMessages.id} DESC
    LIMIT 1
  )`;
}

const markReadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkReadContract.markRead));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  const [thread] = await writeDb
    .select({
      lastReadAt: chatThreads.lastReadAt,
      agentComposeId: chatThreads.agentComposeId,
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

  const agentUnreads = async () => {
    const unreads = await get(
      zeroChatThreadUnreads({
        userId: auth.userId,
        agentComposeId: thread.agentComposeId,
      }),
    );
    return [...unreads];
  };

  const lastReadAt = thread.lastReadAt?.toISOString() ?? null;
  const latestRunFinishAt = latestRunFinishCreatedAtSql();
  const [updated] = await writeDb
    .update(chatThreads)
    .set({ lastReadAt: latestRunFinishAt })
    .where(
      and(
        eq(chatThreads.id, params.id),
        eq(chatThreads.userId, auth.userId),
        isNotNull(latestRunFinishAt),
        or(
          isNull(chatThreads.lastReadAt),
          gt(latestRunFinishAt, chatThreads.lastReadAt),
        )!,
      ),
    )
    .returning({ lastReadAt: chatThreads.lastReadAt });
  signal.throwIfAborted();

  if (!updated) {
    return {
      status: 200 as const,
      body: {
        lastReadAt,
        unreads: await agentUnreads(),
      },
    };
  }

  // Read-state invalidation only. Thread-list shape is unchanged, and
  // clients refetch unread snapshots from this generic user-level topic.
  await publishUserSignal([auth.userId], "chatThreadReadCursorUpdated", {
    threadId: params.id,
    agentId: thread.agentComposeId,
    lastReadAt: updated.lastReadAt?.toISOString() ?? null,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      lastReadAt: updated.lastReadAt?.toISOString() ?? null,
      unreads: await agentUnreads(),
    },
  };
});

export const zeroChatThreadMarkReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkReadContract.markRead,
    handler: authRoute({}, markReadInner$),
  },
];
