import { command } from "ccstate";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { createChatThread$ } from "../services/zero-chat-thread.service";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import type { RouteEntry } from "../route";

const createBody$ = bodyResultOf(chatThreadsContract.create);

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const exists = await get(
    zeroComposeExists({
      orgId: auth.orgId ?? "",
      composeId: body.data.agentId,
    }),
  );
  signal.throwIfAborted();
  if (!exists) {
    return notFound("Agent not found");
  }

  const thread = await set(
    createChatThread$,
    {
      userId: auth.userId,
      agentComposeId: body.data.agentId,
      title: body.data.title,
      clientThreadId: body.data.clientThreadId,
    },
    signal,
  );
  signal.throwIfAborted();

  await publishThreadListChanged(auth.userId);
  signal.throwIfAborted();

  return {
    status: 201 as const,
    body: {
      id: thread.id,
      title: body.data.title ?? null,
      createdAt: thread.createdAt.toISOString(),
    },
  };
});

export const zeroChatThreadCreateRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.create,
    handler: authRoute({}, createInner$),
  },
];
