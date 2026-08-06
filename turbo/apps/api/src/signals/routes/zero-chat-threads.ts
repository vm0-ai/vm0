import { computed } from "ccstate";
import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatEvent,
  type CompatibleChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  clientVersionSupportsCapability,
  CLIENT_CAPABILITY_AGENT_RUN_SOURCE,
  CLIENT_CAPABILITY_BROWSER_LIFECYCLE_OPEN_CLOSE,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import { z } from "zod";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { notFound } from "../../lib/error";
import {
  applyGoogleDriveArtifactSyncStatuses,
  googleDriveArtifactStatusLookup,
} from "../services/google-drive-artifact-sync.service";
import {
  zeroChatSearch,
  zeroChatThreadActiveRunThreadIds,
  zeroChatThreadArtifacts,
  zeroChatThreadDetail,
  zeroChatThreadEventById,
  zeroChatThreadEventsPage,
  zeroChatThreadDraftIds,
  zeroChatThreadUnreadAgentIds,
  zeroChatThreadUnreads,
} from "../services/zero-chat-thread.service";
import {
  getChatThreadEventsSince,
  getChatThreadSnapshot,
} from "../services/zero-chat-thread-event.service";
import { withoutAgentRunSourceAnnotation } from "../services/zero-chat-user-message.service";
import type { RouteEntry } from "../route-entry";
import { zeroChatThreadsArtifactsSyncRoutes } from "./zero-chat-threads-artifacts-sync";
import { zeroChatThreadComputerUseHostRoutes } from "./zero-chat-threads-computer-use-host";
import { zeroChatThreadCreateRoutes } from "./zero-chat-threads-create";
import { zeroChatThreadDeleteRoutes } from "./zero-chat-threads-delete";
import { zeroChatThreadDraftGetRoutes } from "./zero-chat-threads-draft-get";
import { zeroChatThreadGetRoutes } from "./zero-chat-threads-get";
import { zeroChatThreadMarkAgentReadRoutes } from "./zero-chat-threads-mark-agent-read";
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

function isValidChatThreadId(id: string): boolean {
  return chatThreadIdSchema.safeParse(id).success;
}

const canonicalBrowserLifecycleEvents$ = computed((get): boolean => {
  const headers = get(request$).raw.headers;
  if (headers.get(CLIENT_TYPE_HEADER) !== CLIENT_TYPE_APP) {
    return true;
  }
  return clientVersionSupportsCapability(
    headers.get(CLIENT_VERSION_HEADER),
    CLIENT_CAPABILITY_BROWSER_LIFECYCLE_OPEN_CLOSE,
  );
});

function chatEventForClient(
  event: ChatEvent,
  canonicalBrowserLifecycleEvents: boolean,
  supportsAgentRunSource: boolean,
): CompatibleChatEvent {
  const projectedEvent = projectChatEventForClient(
    event,
    supportsAgentRunSource,
  );
  if (canonicalBrowserLifecycleEvents) {
    return projectedEvent;
  }
  if (projectedEvent.eventType === "browser.open") {
    return { ...projectedEvent, eventType: "browser.started" };
  }
  if (projectedEvent.eventType === "browser.close") {
    return { ...projectedEvent, eventType: "browser.stopped" };
  }
  return projectedEvent;
}

function projectChatEventForClient(
  event: ChatEvent,
  supportsAgentRunSource: boolean,
): ChatEvent {
  if (supportsAgentRunSource) {
    return event;
  }
  if (
    event.eventType === "input.prompt" ||
    event.eventType === "input.budget" ||
    event.eventType === "input.goal" ||
    event.eventType === "input.rejected"
  ) {
    return {
      ...event,
      userMessage: withoutAgentRunSourceAnnotation(event.userMessage),
    };
  }
  if (event.eventType === "input.automation" && event.userMessage) {
    return {
      ...event,
      userMessage: withoutAgentRunSourceAnnotation(event.userMessage),
    };
  }
  return event;
}

function clientSupportsAgentRunSource(version: string | null): boolean {
  return clientVersionSupportsCapability(
    version,
    CLIENT_CAPABILITY_AGENT_RUN_SOURCE,
  );
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

const getChatThreadSnapshotInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const snapshot = await getChatThreadSnapshot(db, {
    userId: auth.userId,
    orgId: auth.orgId,
  });

  return {
    status: 200 as const,
    body: {
      chatThreads: [...snapshot.chatThreads],
      latestEventId: snapshot.latestEventId,
      latestSeqId: snapshot.latestSeqId,
    },
  };
});

const listChatThreadLifecycleEventsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatThreadsContract.events));
  const db = get(db$);
  const result = await getChatThreadEventsSince(db, {
    userId: auth.userId,
    orgId: auth.orgId,
    sinceSeqId: query.sinceSeqId,
    sinceEventId: query.sinceEventId,
  });

  if (result.kind === "expired") {
    return {
      status: 410 as const,
      body: {
        error: {
          message: "Chat thread events cursor has expired",
          code: "CHAT_THREAD_EVENTS_EXPIRED",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      events: [...result.events],
      hasMore: result.hasMore,
    },
  };
});

const listChatThreadActiveIdsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const threadIds = await get(
    zeroChatThreadActiveRunThreadIds({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  return { status: 200 as const, body: { threadIds: [...threadIds] } };
});

const listChatEventsInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadEventsContract.list));
  const query = get(queryOf(chatThreadEventsContract.list));
  const clientVersion = get(request$).raw.headers.get(CLIENT_VERSION_HEADER);
  const supportsAgentRunSource = clientSupportsAgentRunSource(clientVersion);

  const events = await get(
    zeroChatThreadEventsPage({
      threadId: params.threadId,
      userId: auth.userId,
      sinceSeqId: query.sinceSeqId,
      beforeSeqId: query.beforeSeqId,
      sinceId: query.sinceId,
      beforeId: query.beforeId,
      limit: query.limit,
    }),
  );
  if (!events) {
    return chatThreadNotFound();
  }

  const canonicalBrowserLifecycleEvents = get(canonicalBrowserLifecycleEvents$);
  return {
    status: 200 as const,
    body: {
      events: events.map((event) => {
        return chatEventForClient(
          event,
          canonicalBrowserLifecycleEvents,
          supportsAgentRunSource,
        );
      }),
    },
  };
});

const getChatThreadEventInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadEventsContract.get));
  const clientVersion = get(request$).raw.headers.get(CLIENT_VERSION_HEADER);
  const supportsAgentRunSource = clientSupportsAgentRunSource(clientVersion);

  const event = await get(
    zeroChatThreadEventById({
      threadId: params.threadId,
      userId: auth.userId,
      eventId: params.eventId,
    }),
  );
  if (!event) {
    return chatThreadNotFound();
  }

  return {
    status: 200 as const,
    body: chatEventForClient(
      event,
      get(canonicalBrowserLifecycleEvents$),
      supportsAgentRunSource,
    ),
  };
});

const listChatThreadDraftsInner$ = computed(async (get) => {
  const auth = get(authContext$);

  const draftThreadIds = await get(
    zeroChatThreadDraftIds({
      userId: auth.userId,
    }),
  );

  return {
    status: 200 as const,
    body: { draftThreadIds: [...draftThreadIds] },
  };
});

const listChatThreadUnreadsInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const query = get(queryOf(chatThreadsContract.unreads));

  const unreads = await get(
    zeroChatThreadUnreads({
      userId: auth.userId,
      agentComposeId: query.agentId,
    }),
  );

  return { status: 200 as const, body: { unreads: [...unreads] } };
});

const listChatThreadUnreadAgentsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const agentIds = await get(
    zeroChatThreadUnreadAgentIds({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  return { status: 200 as const, body: { agentIds: [...agentIds] } };
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
    route: chatThreadsContract.snapshot,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:read",
      },
      getChatThreadSnapshotInner$,
    ),
  },
  {
    route: chatThreadsContract.events,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:read",
      },
      listChatThreadLifecycleEventsInner$,
    ),
  },
  {
    route: chatThreadsContract.activeIds,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listChatThreadActiveIdsInner$,
    ),
  },
  {
    route: chatThreadsContract.drafts,
    handler: authRoute({}, listChatThreadDraftsInner$),
  },
  {
    route: chatThreadsContract.unreads,
    handler: authRoute({}, listChatThreadUnreadsInner$),
  },
  {
    route: chatThreadsContract.unreadAgents,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listChatThreadUnreadAgentsInner$,
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
    route: chatThreadEventsContract.list,
    handler: authRoute(
      { requiredCapability: "chat-event:read" },
      listChatEventsInner$,
    ),
  },
  {
    route: chatThreadEventsContract.get,
    handler: authRoute({}, getChatThreadEventInner$),
  },
  {
    route: chatSearchContract.search,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      searchChatInner$,
    ),
  },
  ...zeroChatThreadsArtifactsSyncRoutes,
  ...zeroChatThreadComputerUseHostRoutes,
  ...zeroChatThreadCreateRoutes,
  ...zeroChatThreadDeleteRoutes,
  ...zeroChatThreadDraftGetRoutes,
  ...zeroChatThreadGetRoutes,
  ...zeroChatThreadMarkAgentReadRoutes,
  ...zeroChatThreadMarkReadRoutes,
  ...zeroChatThreadModelSelectionRoutes,
  ...zeroChatThreadPatchRoutes,
  ...zeroChatThreadPinRoutes,
  ...zeroChatThreadRenameRoutes,
  ...zeroChatThreadUnpinRoutes,
];
