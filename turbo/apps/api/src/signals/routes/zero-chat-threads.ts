import { command, computed } from "ccstate";
import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadMessagesContract,
  chatThreadPendingMessageAppendContract,
  chatThreadPendingMessageDeleteContract,
  chatThreadPendingMessageRecallContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { z } from "zod";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import { notFound } from "../../lib/error";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import {
  zeroChatSearch,
  zeroChatThreadArtifacts,
  zeroChatThreadDetail,
  zeroChatThreadList,
  zeroChatThreadMessagesPage,
  appendZeroChatThreadPendingMessage$,
  deleteZeroChatThreadPendingMessage$,
  recallZeroChatThreadPendingMessage$,
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

const listChatThreadsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatThreadsContract.list));

  if (query.agentId) {
    const exists = await get(
      zeroComposeExists({ orgId: auth.orgId, composeId: query.agentId }),
    );
    if (!exists) {
      return notFound("Agent not found");
    }
  }

  const threads = await get(
    zeroChatThreadList({
      userId: auth.userId,
      orgId: auth.orgId,
      agentComposeId: query.agentId,
    }),
  );

  return { status: 200 as const, body: { threads: [...threads] } };
});

const listChatThreadArtifactsInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadArtifactsContract.list));
  const runs = await get(
    zeroChatThreadArtifacts({ threadId: params.threadId, userId: auth.userId }),
  );
  if (!runs) {
    return chatThreadNotFound();
  }

  return { status: 200 as const, body: { runs: [...runs] } };
});

const searchChatInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatSearchContract.search));
  const result = await get(
    zeroChatSearch({
      userId: auth.userId,
      orgId: auth.orgId,
      keyword: query.keyword,
      agent: query.agent,
      since: query.since,
      limit: query.limit,
      before: query.before,
      after: query.after,
    }),
  );

  return {
    status: 200 as const,
    body: { results: [...result.results], hasMore: result.hasMore },
  };
});

const appendPendingMessageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(
      pathParamsOf(chatThreadPendingMessageAppendContract.append),
    );

    if (!isValidChatThreadId(params.id)) {
      return chatThreadNotFound();
    }

    const bodyResult = await get(
      bodyResultOf(chatThreadPendingMessageAppendContract.append),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const pendingMessage = await set(
      appendZeroChatThreadPendingMessage$,
      {
        threadId: params.id,
        userId: auth.userId,
        content: bodyResult.data.content ?? null,
        attachments: bodyResult.data.attachments ?? null,
      },
      signal,
    );

    if (!pendingMessage) {
      return chatThreadNotFound();
    }

    return { status: 200 as const, body: { pendingMessage } };
  },
);

const deletePendingMessageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(
      pathParamsOf(chatThreadPendingMessageDeleteContract.delete),
    );

    if (!isValidChatThreadId(params.id)) {
      return chatThreadNotFound();
    }

    const found = await set(
      deleteZeroChatThreadPendingMessage$,
      { threadId: params.id, userId: auth.userId },
      signal,
    );

    if (!found) {
      return chatThreadNotFound();
    }

    return { status: 204 as const, body: undefined };
  },
);

const recallPendingMessageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(
      pathParamsOf(chatThreadPendingMessageRecallContract.recall),
    );

    if (!isValidChatThreadId(params.id)) {
      return chatThreadNotFound();
    }

    const result = await set(
      recallZeroChatThreadPendingMessage$,
      { threadId: params.id, userId: auth.userId },
      signal,
    );

    if (!result.ok) {
      return result.reason === "pending-not-found"
        ? notFound("Pending message not found")
        : chatThreadNotFound();
    }

    return {
      status: 200 as const,
      body: {
        draftContent: result.draftContent,
        draftAttachments: result.draftAttachments
          ? [...result.draftAttachments]
          : null,
        pendingMessage: null,
      },
    };
  },
);

export const zeroChatThreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.list,
    handler: shadowCompareRoute({
      route: chatThreadsContract.list,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        listChatThreadsInner$,
      ),
    }),
  },
  {
    route: chatThreadByIdContract.get,
    handler: shadowCompareRoute({
      route: chatThreadByIdContract.get,
      handler: authRoute({}, getChatThreadInner$),
    }),
  },
  {
    route: chatThreadArtifactsContract.list,
    handler: shadowCompareRoute({
      route: chatThreadArtifactsContract.list,
      handler: authRoute({}, listChatThreadArtifactsInner$),
    }),
  },
  {
    route: chatThreadMessagesContract.list,
    handler: shadowCompareRoute({
      route: chatThreadMessagesContract.list,
      handler: authRoute({}, listChatThreadMessagesInner$),
    }),
  },
  {
    route: chatThreadPendingMessageAppendContract.append,
    handler: authRoute({}, appendPendingMessageInner$),
  },
  {
    route: chatThreadPendingMessageDeleteContract.delete,
    handler: authRoute({}, deletePendingMessageInner$),
  },
  {
    route: chatThreadPendingMessageRecallContract.recall,
    handler: authRoute({}, recallPendingMessageInner$),
  },
  {
    route: chatSearchContract.search,
    handler: shadowCompareRoute({
      route: chatSearchContract.search,
      handler: authRoute(
        {
          requireOrganization: true,
          missingOrganizationStatus: 401,
          requiredCapability: "chat-message:read",
        },
        searchChatInner$,
      ),
    }),
  },
];
