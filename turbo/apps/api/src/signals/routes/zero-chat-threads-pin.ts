import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadPinContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { appendChatThreadEvent } from "../services/zero-chat-thread-event.service";
import type { RouteEntry } from "../route-entry";

const pinInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadPinContract.pin));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);
  const updated = await writeDb.transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ pinnedAt: nowDate() })
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
      kind: "pinned",
      userId: auth.userId,
      orgId: auth.orgId,
      chatThreadId: thread.id,
      agentComposeId: thread.agentComposeId,
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

export const zeroChatThreadPinRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadPinContract.pin,
    handler: authRoute({}, pinInner$),
  },
];
