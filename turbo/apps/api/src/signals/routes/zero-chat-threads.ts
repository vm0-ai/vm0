import { computed } from "ccstate";
import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { z } from "zod";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { notFound } from "../../lib/error";
import {
  applyGoogleDriveArtifactSyncStatuses,
  googleDriveArtifactStatusLookup,
} from "../services/google-drive-artifact-sync.service";
import {
  zeroChatSearch,
  zeroChatIndicators,
  zeroChatThreadActiveRunThreadIds,
  zeroChatThreadArtifacts,
  zeroChatThreadDetail,
  zeroChatThreadEventById,
  zeroChatThreadEventsPage,
  zeroChatThreadQueuedEvents,
  zeroChatThreadDraftIds,
  zeroChatThreadUnreadAgentIds,
  zeroChatThreadUnreadThreadIds,
  zeroChatThreadUnreads,
} from "../services/zero-chat-thread.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  zeroChatThreadEventRows,
  zeroChatThreadEventSnapshot,
} from "../services/zero-chat-event-snapshot.service";
import {
  getChatThreadEventsSince,
  getChatThreadSnapshot,
} from "../services/zero-chat-thread-event.service";
import {
  legacyFeedbackLocationAppClient$,
  projectLegacyChatEvent,
  projectLegacyChatEventRow,
} from "../services/chat-feedback-location-compatibility.service";
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

const chatEventSnapshotReadDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Chat event snapshot read is not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

const chatEventSnapshotReadEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await get(userFeatureSwitchContext(auth.orgId, auth.userId));
  return isFeatureEnabled(FeatureSwitchKey.ChatEventSnapshotRead, context);
});

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

const listZeroIndicatorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const indicators = await get(
    zeroChatIndicators({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  return { status: 200 as const, body: indicators };
});

const listChatEventsInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadEventsContract.list));
  const query = get(queryOf(chatThreadEventsContract.list));
  const legacyFeedbackLocationClient = get(legacyFeedbackLocationAppClient$);
  const events = await get(
    zeroChatThreadEventsPage({
      threadId: params.threadId,
      userId: auth.userId,
      sinceSeqId: query.sinceSeqId,
      beforeSeqId: query.beforeSeqId,
      limit: query.limit,
    }),
  );
  if (!events) {
    return chatThreadNotFound();
  }

  return {
    status: 200 as const,
    body: {
      events: legacyFeedbackLocationClient
        ? events.map(projectLegacyChatEvent)
        : events,
    },
  };
});

const getChatEventSnapshotInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadEventsContract.snapshot));
  const snapshot = await get(
    zeroChatThreadEventSnapshot({
      threadId: params.threadId,
      userId: auth.userId,
    }),
  );
  if (snapshot.kind === "thread-not-found") {
    return chatThreadNotFound();
  }
  if (snapshot.kind === "snapshot-not-found") {
    return {
      status: 404 as const,
      body: {
        error: {
          message: "Chat event snapshot not found",
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      url: snapshot.url,
      expiresInSeconds: snapshot.expiresInSeconds,
      lastSeqId: snapshot.lastSeqId,
    },
  };
});

const listChatEventRowsInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadEventsContract.rows));
  const query = get(queryOf(chatThreadEventsContract.rows));
  const legacyFeedbackLocationClient = get(legacyFeedbackLocationAppClient$);
  const page = await get(
    zeroChatThreadEventRows({
      threadId: params.threadId,
      userId: auth.userId,
      sinceSeqId: query.sinceSeqId,
      limit: query.limit,
    }),
  );
  if (page.kind === "thread-not-found") {
    return chatThreadNotFound();
  }
  if (page.kind === "expired") {
    return {
      status: 410 as const,
      body: {
        error: {
          message: "Chat events cursor has expired",
          code: "CHAT_EVENTS_EXPIRED",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      rows: legacyFeedbackLocationClient
        ? page.rows.map(projectLegacyChatEventRow)
        : [...page.rows],
    },
  };
});

const listQueuedChatEventsInner$ = computed(async (get) => {
  if (!(await get(chatEventSnapshotReadEnabled$))) {
    return chatEventSnapshotReadDisabled;
  }
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadEventsContract.queued));
  const events = await get(
    zeroChatThreadQueuedEvents({
      threadId: params.threadId,
      userId: auth.userId,
    }),
  );
  if (!events) {
    return chatThreadNotFound();
  }
  return {
    status: 200 as const,
    body: { events: [...events] },
  };
});

const getChatThreadEventInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadEventsContract.get));
  const legacyFeedbackLocationClient = get(legacyFeedbackLocationAppClient$);
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
    body: legacyFeedbackLocationClient ? projectLegacyChatEvent(event) : event,
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

const listChatThreadUnreadIdsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const threadIds = await get(
    zeroChatThreadUnreadThreadIds({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  return { status: 200 as const, body: { threadIds: [...threadIds] } };
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
    route: chatThreadsContract.indicators,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listZeroIndicatorsInner$,
    ),
  },
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
    route: chatThreadsContract.unreadIds,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listChatThreadUnreadIdsInner$,
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
    route: chatThreadEventsContract.snapshot,
    handler: authRoute(
      { requiredCapability: "chat-event:read" },
      getChatEventSnapshotInner$,
    ),
  },
  {
    route: chatThreadEventsContract.rows,
    handler: authRoute(
      { requiredCapability: "chat-event:read" },
      listChatEventRowsInner$,
    ),
  },
  {
    route: chatThreadEventsContract.queued,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      listQueuedChatEventsInner$,
    ),
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
