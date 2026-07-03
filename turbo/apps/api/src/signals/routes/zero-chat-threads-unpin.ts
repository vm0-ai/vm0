import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadUnpinContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { appendChatThreadEvent } from "../services/zero-chat-thread-event.service";
import type { RouteEntry } from "../route-entry";

const unpinInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadUnpinContract.unpin));
  const query = get(queryOf(chatThreadUnpinContract.unpin));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  const updated = await writeDb.transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ pinnedAt: null })
      .where(
        and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
      )
      .returning({
        id: chatThreads.id,
        agentComposeId: chatThreads.agentComposeId,
      });
    if (!thread) {
      return false;
    }
    await appendChatThreadEvent(tx, {
      kind: "unpinned",
      userId: auth.userId,
      orgId: auth.orgId,
      chatThreadId: thread.id,
      agentComposeId: thread.agentComposeId,
      eventId: query?.eventId,
    });
    return true;
  });
  signal.throwIfAborted();

  if (!updated) {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged(auth.userId);
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

export const zeroChatThreadUnpinRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadUnpinContract.unpin,
    handler: authRoute({}, unpinInner$),
  },
];
