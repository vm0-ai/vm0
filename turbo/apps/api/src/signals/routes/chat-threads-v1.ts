import { computed } from "ccstate";
import {
  chatThreadV1GetContract,
  chatThreadV1MessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads-v1";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  chatThreadMessagesV1,
  ownedChatThreadV1,
} from "../services/chat-thread.service";
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

const getThread$ = authRoute({ accept: ["pat"] }, getThreadHandler$);
const getThreadMessages$ = authRoute(
  { accept: ["pat"] },
  getThreadMessagesHandler$,
);

export const chatThreadsV1Routes: readonly RouteEntry[] = [
  { route: chatThreadV1GetContract.get, handler: getThread$ },
  { route: chatThreadV1MessagesContract.list, handler: getThreadMessages$ },
];
