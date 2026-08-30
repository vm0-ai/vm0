import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  LEGACY_CHAT_EVENT_PROJECTION,
  withLegacyChatEventProjection,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command, computed } from "ccstate";
import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { z } from "zod";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { request$, setResHeader$ } from "../context/hono";
import { db$ } from "../external/db";
import { notFound } from "../../lib/error";
import {
  applyGoogleDriveArtifactSyncStatuses,
  googleDriveArtifactStatusLookup,
} from "../services/google-drive-artifact-sync.service";
import {
  chatIndicators,
  chatThreadArtifacts,
  chatThreadDetail,
  chatThreadDraftIds,
  chatThreadUnreads,
} from "../services/chat-thread.service";
import { chatSearch } from "../services/chat-search.service";
import {
  chatThreadEventRows,
  chatThreadEventSnapshot,
} from "../services/chat-event-snapshot.service";
import { resolveChatEventSchemaVersion } from "../services/chat-event-schema-version.service";
import {
  getChatThreadEventsSince,
  getChatThreadSnapshot,
} from "../services/chat-thread-event.service";
import type { RouteEntry } from "../route-entry";
import { chatThreadsArtifactsSyncRoutes } from "./chat-threads-artifacts-sync";
import { chatThreadComputerUseHostRoutes } from "./chat-threads-computer-use-host";
import { chatThreadConnectorSelectionRoutes } from "./chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "./chat-threads-create";
import { chatThreadDeleteRoutes } from "./chat-threads-delete";
import { chatThreadDraftGetRoutes } from "./chat-threads-draft-get";
import { chatThreadGetRoutes } from "./chat-threads-get";
import { chatThreadImageModelRoutes } from "./chat-threads-image-model";
import { chatThreadMarkAgentReadRoutes } from "./chat-threads-mark-agent-read";
import { chatThreadMarkReadRoutes } from "./chat-threads-mark-read";
import { chatThreadMarkUnreadRoutes } from "./chat-threads-mark-unread";
import { chatThreadModelSelectionRoutes } from "./chat-threads-model-selection";
import { chatThreadVideoModelRoutes } from "./chat-threads-video-model";
import { chatThreadPatchRoutes } from "./chat-threads-patch";
import { chatThreadPinRoutes } from "./chat-threads-pin";
import { chatThreadRenameRoutes } from "./chat-threads-rename";
import { chatThreadUnpinRoutes } from "./chat-threads-unpin";

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
    chatThreadDetail({ threadId: params.id, userId: auth.userId }),
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

const listChatIndicatorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const indicators = await get(
    chatIndicators({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  return { status: 200 as const, body: indicators };
});

const getChatEventSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadEventsContract.snapshot));
    const version = resolveChatEventSchemaVersion(
      get(request$).header(CHAT_EVENT_SCHEMA_VERSION_HEADER),
    );
    if (version.kind === "error") {
      return version.response;
    }
    set(
      setResHeader$,
      CHAT_EVENT_SCHEMA_VERSION_HEADER,
      version.version.toString(),
    );
    const snapshot = await set(
      chatThreadEventSnapshot({
        threadId: params.threadId,
        userId: auth.userId,
      }),
      signal,
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
        lastEventId: snapshot.lastEventId,
        lastSeqId: snapshot.lastSeqId,
        projection: LEGACY_CHAT_EVENT_PROJECTION,
      },
    };
  },
);

const listChatEventRowsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadEventsContract.rows));
    const query = get(queryOf(chatThreadEventsContract.rows));
    const version = resolveChatEventSchemaVersion(
      get(request$).header(CHAT_EVENT_SCHEMA_VERSION_HEADER),
    );
    if (version.kind === "error") {
      return version.response;
    }
    set(
      setResHeader$,
      CHAT_EVENT_SCHEMA_VERSION_HEADER,
      version.version.toString(),
    );
    const page = await get(
      chatThreadEventRows({
        threadId: params.threadId,
        userId: auth.userId,
        limit: query.limit,
        ...(query.sinceEventId === undefined
          ? { sinceSeqId: 0 as const }
          : {
              sinceSeqId: query.sinceSeqId,
              sinceEventId: query.sinceEventId,
            }),
      }),
    );
    signal.throwIfAborted();
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
        rows: [...page.rows],
        cursor: withLegacyChatEventProjection(page.cursor),
        hasMore: page.hasMore,
        projection: LEGACY_CHAT_EVENT_PROJECTION,
      },
    };
  },
);

const listChatThreadDraftsInner$ = computed(async (get) => {
  const auth = get(authContext$);

  const draftThreadIds = await get(
    chatThreadDraftIds({
      userId: auth.userId,
    }),
  );

  return {
    status: 200 as const,
    body: { draftThreadIds: [...draftThreadIds] },
  };
});

const listChatThreadUnreadsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatThreadsContract.unreads));

  const unreads = await get(
    chatThreadUnreads({
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: query.agentId,
    }),
  );

  return { status: 200 as const, body: { unreads: [...unreads] } };
});

const listChatThreadArtifactsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadArtifactsContract.list));
    const [runs, lookup] = await Promise.all([
      get(
        chatThreadArtifacts({
          threadId: params.threadId,
          userId: auth.userId,
        }),
      ),
      set(
        googleDriveArtifactStatusLookup({
          threadId: params.threadId,
          orgId: auth.orgId,
          userId: auth.userId,
        }),
        signal,
      ),
    ]);
    signal.throwIfAborted();
    if (!runs) {
      return chatThreadNotFound();
    }

    return {
      status: 200 as const,
      body: { runs: applyGoogleDriveArtifactSyncStatuses(runs, lookup) },
    };
  },
);

const searchChatInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatSearchContract.search));
  const result = await get(
    chatSearch({
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

export const chatThreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.indicators,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listChatIndicatorsInner$,
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
    route: chatThreadsContract.drafts,
    handler: authRoute({}, listChatThreadDraftsInner$),
  },
  {
    route: chatThreadsContract.unreads,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:read",
      },
      listChatThreadUnreadsInner$,
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
  ...chatThreadsArtifactsSyncRoutes,
  ...chatThreadComputerUseHostRoutes,
  ...chatThreadConnectorSelectionRoutes,
  ...chatThreadCreateRoutes,
  ...chatThreadDeleteRoutes,
  ...chatThreadDraftGetRoutes,
  ...chatThreadGetRoutes,
  ...chatThreadImageModelRoutes,
  ...chatThreadMarkAgentReadRoutes,
  ...chatThreadMarkReadRoutes,
  ...chatThreadMarkUnreadRoutes,
  ...chatThreadModelSelectionRoutes,
  ...chatThreadPatchRoutes,
  ...chatThreadPinRoutes,
  ...chatThreadRenameRoutes,
  ...chatThreadUnpinRoutes,
  ...chatThreadVideoModelRoutes,
];
