import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadMarkUnreadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import { chatThreadUnreads } from "../services/chat-thread.service";
import type { RouteEntry } from "../route-entry";

const markUnreadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkUnreadContract.markUnread));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);
  const [thread] = await writeDb
    .update(chatThreads)
    .set({ lastReadAt: null })
    .from(agents)
    .where(
      and(
        eq(chatThreads.id, params.id),
        eq(chatThreads.userId, auth.userId),
        eq(agents.id, chatThreads.agentId),
        isNotNull(chatThreads.agentId),
      ),
    )
    .returning({ agentId: agents.id, orgId: agents.orgId });
  signal.throwIfAborted();

  if (!thread) {
    return notFound("Chat thread not found");
  }

  await publishChatThreadReadCursorUpdatedSafely(
    { userId: auth.userId, orgId: thread.orgId },
    {
      threadId: params.id,
      agentId: thread.agentId,
      lastReadAt: null,
    },
  );
  signal.throwIfAborted();

  const unreads = await get(
    chatThreadUnreads({
      userId: auth.userId,
      orgId: thread.orgId,
      agentId: thread.agentId,
    }),
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      lastReadAt: null,
      unreads: [...unreads],
    },
  };
});

export const chatThreadMarkUnreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkUnreadContract.markUnread,
    handler: authRoute({}, markUnreadInner$),
  },
];
