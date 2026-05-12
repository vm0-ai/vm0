import { command, computed } from "ccstate";
import {
  chatThreadV1GetContract,
  chatThreadV1MessagesContract,
  chatThreadV1SendContract,
} from "@vm0/api-contracts/contracts/chat-threads-v1";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { now } from "../external/time";
import { notFound } from "../../lib/error";
import {
  chatThreadMessagesV1,
  ownedChatThreadV1,
} from "../services/chat-thread.service";
import { sendChatThreadMessageV1$ } from "../services/chat-thread-v1-send.service";
import type { RouteEntry } from "../route";

const getThreadHandler$ = computed(async (get) => {
  const auth = get(authContext$);
  const { threadId } = get(pathParamsOf(chatThreadV1GetContract.get));

  const thread = await get(ownedChatThreadV1(threadId, auth.userId));
  if (!thread) {
    return notFound("Chat thread not found");
  }
  return { status: 200 as const, body: thread };
});

const getThreadMessagesHandler$ = computed(async (get) => {
  const auth = get(authContext$);
  const { threadId } = get(pathParamsOf(chatThreadV1MessagesContract.list));
  const { sinceId, beforeId, limit } = get(
    queryOf(chatThreadV1MessagesContract.list),
  );

  const messages = await get(
    chatThreadMessagesV1({
      threadId,
      userId: auth.userId,
      sinceId,
      beforeId,
      limit,
    }),
  );
  if (messages === null) {
    return notFound("Chat thread not found");
  }
  return { status: 200 as const, body: { messages: [...messages] } };
});

const sendThreadMessageBody$ = bodyResultOf(chatThreadV1SendContract.send);

const sendThreadMessageHandler$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const apiStartTime = now();
    const auth = get(organizationAuthContext$);
    const body = await get(sendThreadMessageBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      sendChatThreadMessageV1$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        prompt: body.data.prompt,
        threadId: body.data.threadId,
        apiStartTime,
      },
      signal,
    );
  },
);

const getThread$ = authRoute({ accept: ["pat"] }, getThreadHandler$);
const getThreadMessages$ = authRoute(
  { accept: ["pat"] },
  getThreadMessagesHandler$,
);
const sendThreadMessage$ = authRoute(
  {
    accept: ["pat"],
    requireOrganization: true,
    missingOrganizationStatus: 401,
  },
  sendThreadMessageHandler$,
);

export const chatThreadsV1Routes: readonly RouteEntry[] = [
  { route: chatThreadV1GetContract.get, handler: getThread$ },
  { route: chatThreadV1MessagesContract.list, handler: getThreadMessages$ },
  { route: chatThreadV1SendContract.send, handler: sendThreadMessage$ },
];
