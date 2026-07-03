import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadRenameContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { appendChatThreadEvent } from "../services/zero-chat-thread-event.service";
import type { RouteEntry } from "../route-entry";

const renameBody$ = bodyResultOf(chatThreadRenameContract.rename);

const renameInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadRenameContract.rename));
  const body = await get(renameBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const writeDb = set(writeDb$);

  const updated = await writeDb.transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ title: body.data.title, renamedAt: nowDate() })
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
      kind: "renamed",
      userId: auth.userId,
      orgId: auth.orgId,
      chatThreadId: thread.id,
      agentComposeId: thread.agentComposeId,
      eventId: body.data.eventId,
      title: body.data.title,
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

export const zeroChatThreadRenameRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadRenameContract.rename,
    handler: authRoute(
      { requiredCapability: "chat-thread:write" },
      renameInner$,
    ),
  },
];
