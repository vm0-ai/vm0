import { command, computed } from "ccstate";
import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadGithubPrsContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
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
import { zeroChatThreadGithubPrs$ } from "../services/chat-thread-github-prs.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import type { RouteEntry } from "../route";
import { zeroChatThreadsArtifactsSyncRoutes } from "./zero-chat-threads-artifacts-sync";
import { zeroChatThreadCreateRoutes } from "./zero-chat-threads-create";
import { zeroChatThreadDeleteRoutes } from "./zero-chat-threads-delete";
import { zeroChatThreadMarkReadRoutes } from "./zero-chat-threads-mark-read";
import { zeroChatThreadModelSelectionRoutes } from "./zero-chat-threads-model-selection";
import { zeroChatThreadPatchRoutes } from "./zero-chat-threads-patch";
import { zeroChatThreadPinRoutes } from "./zero-chat-threads-pin";
import { zeroChatThreadRenameRoutes } from "./zero-chat-threads-rename";
import { zeroChatThreadUnpinRoutes } from "./zero-chat-threads-unpin";

const chatThreadIdSchema = z.string().uuid();

function chatThreadNotFound() {
  return notFound("Chat thread not found");
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" } },
  };
}

function badGateway(message: string) {
  return {
    status: 502 as const,
    body: { error: { message, code: "BAD_GATEWAY" } },
  };
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

  const page = await get(
    zeroChatThreadList({
      userId: auth.userId,
      orgId: auth.orgId,
      agentComposeId: query.agentId,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );

  return {
    status: 200 as const,
    body: {
      pinned: [...page.pinned],
      threads: [...page.threads],
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
    },
  };
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

const listChatThreadGithubPrsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();

    if (
      !isFeatureEnabled(FeatureSwitchKey.ChatGithubPrTracking, {
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return forbidden("GitHub PR tracking is not enabled");
    }

    const params = get(pathParamsOf(chatThreadGithubPrsContract.list));
    if (!isValidChatThreadId(params.threadId)) {
      return chatThreadNotFound();
    }

    const result = await set(
      zeroChatThreadGithubPrs$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        threadId: params.threadId,
      },
      signal,
    );

    if (result.status === "not_found") {
      return chatThreadNotFound();
    }
    if (result.status === "forbidden") {
      return forbidden(result.message);
    }
    if (result.status === "bad_gateway") {
      return badGateway(result.message);
    }

    return { status: 200 as const, body: { prs: [...result.prs] } };
  },
);

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
    route: chatThreadGithubPrsContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listChatThreadGithubPrsInner$,
    ),
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
  ...zeroChatThreadModelSelectionRoutes,
  ...zeroChatThreadPatchRoutes,
  ...zeroChatThreadPinRoutes,
  ...zeroChatThreadRenameRoutes,
  ...zeroChatThreadUnpinRoutes,
];
