import { command } from "ccstate";
import { and, desc, eq } from "drizzle-orm";
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
    .select({ lastReadMessageId: chatThreads.lastReadMessageId })
    .from(chatThreads)
    .where(
      and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!thread) {
    return notFound("Chat thread not found");
  }

  const [latest] = await writeDb
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, params.id),
        visibleChatMessageCondition(),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1);
  signal.throwIfAborted();

  const latestMessageId = latest?.id ?? null;
  if (thread.lastReadMessageId === latestMessageId) {
    return {
      status: 200 as const,
      body: { lastReadMessageId: latestMessageId, changed: false },
    };
  }

  await writeDb
    .update(chatThreads)
    .set({ lastReadMessageId: latestMessageId })
    .where(
      and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
    );
  signal.throwIfAborted();

  await publishUserSignal(
    [auth.userId],
    `chatThreadReadCursorUpdated:${params.id}`,
    { lastReadMessageId: latestMessageId },
  );
  signal.throwIfAborted();
  await publishThreadListChanged(auth.userId);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { lastReadMessageId: latestMessageId, changed: true },
  };
});

export const zeroChatThreadMarkReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkReadContract.markRead,
    handler: authRoute({}, markReadInner$),
  },
];
