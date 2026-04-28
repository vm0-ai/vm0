import { command } from "ccstate";
import {
  chatThreadV1GetContract,
  chatThreadV1MessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads-v1";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { badRequest, notFound } from "../../lib/error";
import {
  chatThreadMessagesV1,
  ownedChatThreadV1,
} from "../services/chat-thread.service";
import type { RouteEntry } from "../route";

const GENERIC_BAD_REQUEST = Object.freeze({ path: [], message: "Bad request" });

const getThreadHandler$ = command(async ({ get }, _signal: AbortSignal) => {
  const auth = get(authContext$);
  const request = get(request$);

  const params = chatThreadV1GetContract.get.pathParams.safeParse({
    threadId: request.param("threadId"),
  });
  if (!params.success) {
    return badRequest(params.error.issues[0] ?? GENERIC_BAD_REQUEST);
  }

  const thread = await get(
    ownedChatThreadV1(params.data.threadId, auth.userId),
  );
  if (!thread) {
    return notFound("Chat thread not found");
  }
  return { status: 200 as const, body: thread };
});

const getThreadMessagesHandler$ = command(
  async ({ get }, _signal: AbortSignal) => {
    const auth = get(authContext$);
    const request = get(request$);

    const params = chatThreadV1MessagesContract.list.pathParams.safeParse({
      threadId: request.param("threadId"),
    });
    if (!params.success) {
      return badRequest(params.error.issues[0] ?? GENERIC_BAD_REQUEST);
    }

    const query = chatThreadV1MessagesContract.list.query.safeParse({
      sinceId: request.query("sinceId"),
      beforeId: request.query("beforeId"),
      limit: request.query("limit"),
    });
    if (!query.success) {
      return badRequest(query.error.issues[0] ?? GENERIC_BAD_REQUEST);
    }

    const messages = await get(
      chatThreadMessagesV1({
        threadId: params.data.threadId,
        userId: auth.userId,
        sinceId: query.data.sinceId,
        beforeId: query.data.beforeId,
        limit: query.data.limit,
      }),
    );
    if (messages === null) {
      return notFound("Chat thread not found");
    }
    return { status: 200 as const, body: { messages: [...messages] } };
  },
);

const getThread$ = authRoute({ accept: ["pat"] }, getThreadHandler$);
const getThreadMessages$ = authRoute(
  { accept: ["pat"] },
  getThreadMessagesHandler$,
);

export const chatThreadsV1Routes: readonly RouteEntry[] = [
  { route: chatThreadV1GetContract.get, handler: getThread$ },
  { route: chatThreadV1MessagesContract.list, handler: getThreadMessages$ },
];
