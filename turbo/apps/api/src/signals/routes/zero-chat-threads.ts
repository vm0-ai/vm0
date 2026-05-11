import { computed } from "ccstate";
import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { z } from "zod";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { notFound } from "../../lib/error";
import { zeroComposeExists } from "../services/zero-compose-data.service";
import {
  applyGoogleDriveArtifactSyncStatuses,
  googleDriveArtifactStatusLookup,
} from "../services/google-drive-artifact-sync.service";
import {
  zeroChatSearch,
  zeroChatThreadArtifacts,
  zeroChatThreadDetail,
  zeroChatThreadList,
  zeroChatThreadMessagesPage,
} from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route";
import { zeroChatThreadsArtifactsSyncRoutes } from "./zero-chat-threads-artifacts-sync";
import { zeroChatThreadCreateRoutes } from "./zero-chat-threads-create";
import { zeroChatThreadDeleteRoutes } from "./zero-chat-threads-delete";
import { zeroChatThreadMarkReadRoutes } from "./zero-chat-threads-mark-read";
import { zeroChatThreadPatchRoutes } from "./zero-chat-threads-patch";
import { zeroChatThreadPinRoutes } from "./zero-chat-threads-pin";
import { zeroChatThreadRenameRoutes } from "./zero-chat-threads-rename";
import { zeroChatThreadUnpinRoutes } from "./zero-chat-threads-unpin";

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
  const [runs, lookup] = await Promise.all([
    get(
      zeroChatThreadArtifacts({
        threadId: params.threadId,
        userId: auth.userId,
      }),
    ),
    get(
      googleDriveArtifactStatusLookup({
        threadId: params.threadId,
        orgId: auth.orgId,
        userId: auth.userId,
      }),
    ),
  ]);
  if (!runs) {
    return chatThreadNotFound();
  }

  return {
    status: 200 as const,
    body: { runs: applyGoogleDriveArtifactSyncStatuses(runs, lookup) },
  };
});

const searchChatInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatSearchContract.search));
  const result = await get(
    zeroChatSearch({
      userId: auth.userId,
      orgId: auth.orgId,
      keyword: query.keyword,
      agentId: query.agentId,
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

export const zeroChatThreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listChatThreadsInner$,
    ),
  },
  {
    route: chatThreadByIdContract.get,
    handler: authRoute({}, getChatThreadInner$),
  },
  {
    route: chatThreadArtifactsContract.list,
    handler: authRoute({}, listChatThreadArtifactsInner$),
  },
  {
    route: chatThreadMessagesContract.list,
    handler: authRoute({}, listChatThreadMessagesInner$),
  },
  {
    route: chatSearchContract.search,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      searchChatInner$,
    ),
  },
  ...zeroChatThreadsArtifactsSyncRoutes,
  ...zeroChatThreadCreateRoutes,
  ...zeroChatThreadDeleteRoutes,
  ...zeroChatThreadMarkReadRoutes,
  ...zeroChatThreadPatchRoutes,
  ...zeroChatThreadPinRoutes,
  ...zeroChatThreadRenameRoutes,
  ...zeroChatThreadUnpinRoutes,
];
