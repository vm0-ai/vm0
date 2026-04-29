import { computed } from "ccstate";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { z } from "zod";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import {
  shadowCompareRoute,
  type ShadowCompareSource,
} from "../context/shadow-compare";
import { notFound } from "../../lib/error";
import {
  zeroChatThreadDetail,
  zeroChatThreadMessagesPage,
} from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route";

const chatThreadIdSchema = z.string().uuid();

function chatThreadNotFound() {
  return notFound("Chat thread not found");
}

function isValidChatThreadId(id: string): boolean {
  return chatThreadIdSchema.safeParse(id).success;
}

const getChatThreadInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.get));

  if (!isValidChatThreadId(params.id)) {
    return chatThreadNotFound();
  }

  const thread = await get(
    zeroChatThreadDetail({ threadId: params.id, userId: auth.userId }),
  );
  if (!thread) {
    return chatThreadNotFound();
  }

  return { status: 200 as const, body: thread };
});

const listChatThreadMessagesInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMessagesContract.list));
  const query = get(queryOf(chatThreadMessagesContract.list));

  const page = await get(
    zeroChatThreadMessagesPage({
      threadId: params.threadId,
      userId: auth.userId,
      sinceId: query.sinceId,
      beforeId: query.beforeId,
      limit: query.limit,
    }),
  );
  if (!page) {
    return chatThreadNotFound();
  }

  return {
    status: 200 as const,
    body: {
      messages: [...page.messages],
      hasHistoryBefore: page.hasHistoryBefore,
    },
  };
});

export function zeroChatThreadRoutes(
  source: ShadowCompareSource = "web",
): readonly RouteEntry[] {
  return [
    {
      route: chatThreadByIdContract.get,
      handler: shadowCompareRoute({
        routeName: "zero.chat-threads.byId",
        handler: authRoute({}, getChatThreadInner$),
        source,
      }),
    },
    {
      route: chatThreadMessagesContract.list,
      handler: shadowCompareRoute({
        routeName: "zero.chat-threads.messages",
        handler: authRoute({}, listChatThreadMessagesInner$),
        source,
      }),
    },
  ];
}
