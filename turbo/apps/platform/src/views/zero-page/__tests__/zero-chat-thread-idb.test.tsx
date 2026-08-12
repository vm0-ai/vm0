import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEventRowV4 } from "@vm0/api-contracts/contracts/chat-event-rows";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadMarkReadContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroBrowserContract } from "@vm0/api-contracts/contracts/zero-browser";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockOrganization, mockUser } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_EVENT_ROWS_STORE,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "../../../signals/external/chat-idb-schema.ts";
import {
  chatIdb$,
  openChatIdb,
} from "../../../signals/external/chat-idb-store.ts";
import { setLogErrorHandler } from "../../../signals/log.ts";
import { navigateToChat$ } from "../../../signals/zero-page/zero-nav.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const THREAD_TITLE = "GEO pricing research";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const OTHER_THREAD_TITLE = "Other pricing research";
const USER_MESSAGE = "Summarize the launch plan";
const ASSISTANT_MESSAGE = "Here is the result";
const IDB_USER_ID = "zero-chat-thread-idb-user";
const IDB_ORG_ID = "zero-chat-thread-idb-org";
const EMPTY_THREAD_MESSAGE = "Send a message to start the conversation";

function observeEmptyThreadMessage(): {
  readonly wasShown: () => boolean;
  readonly disconnect: () => void;
} {
  let wasShown = false;
  const record = () => {
    if (
      document.querySelector("[data-chat-skeleton]") === null &&
      document.body.textContent?.includes(EMPTY_THREAD_MESSAGE)
    ) {
      wasShown = true;
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(document.body, { childList: true, subtree: true });
  record();
  return {
    wasShown: () => {
      return wasShown;
    },
    disconnect: () => {
      observer.disconnect();
    },
  };
}

async function primeRuntimeChatDb(): Promise<
  Awaited<ReturnType<typeof openChatIdb>>
> {
  mockUser({ id: IDB_USER_ID, fullName: "Test User" }, { token: "test-token" });
  mockOrganization({
    activeOrg: { id: IDB_ORG_ID, name: "Default Org" },
    memberships: [{ id: IDB_ORG_ID }],
  });
  return await context.store.get(chatIdb$);
}

function setupChatPage(): void {
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    user: { id: IDB_USER_ID, fullName: "Test User" },
    org: {
      activeOrg: { id: IDB_ORG_ID, name: "Default Org" },
      memberships: [{ id: IDB_ORG_ID }],
    },
  });
}

async function clearCachedChatData(): Promise<void> {
  const db = await openChatIdb(IDB_USER_ID, IDB_ORG_ID);
  try {
    const tx = db.transaction(
      [
        CHAT_EVENT_ROWS_STORE,
        CHAT_THREAD_SNAPSHOT_STORE,
        CHAT_THREAD_EVENTS_STORE,
        CHAT_THREAD_EVENT_SYNC_STORE,
      ],
      "readwrite",
    );
    const eventRowsStore = tx.objectStore(CHAT_EVENT_ROWS_STORE);
    const threadSnapshotStore = tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE);
    const threadEventsStore = tx.objectStore(CHAT_THREAD_EVENTS_STORE);
    const threadEventSyncStore = tx.objectStore(CHAT_THREAD_EVENT_SYNC_STORE);
    const clearEventRows = eventRowsStore.clear.bind(eventRowsStore);
    const clearThreadSnapshot =
      threadSnapshotStore.clear.bind(threadSnapshotStore);
    const clearThreadEvents = threadEventsStore.clear.bind(threadEventsStore);
    const clearThreadEventSync =
      threadEventSyncStore.clear.bind(threadEventSyncStore);
    await Promise.all([
      clearEventRows(),
      clearThreadSnapshot(),
      clearThreadEvents(),
      clearThreadEventSync(),
      tx.done,
    ]);
  } finally {
    db.close();
  }
}

function prepareDefaultAgent(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: IDB_USER_ID,
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

function mockCurrentThreadDetail(): void {
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: "2026-03-10T00:00:00Z",
      cancellationRecoveryPending: false,
    });
  });
}

function currentThreadSnapshot() {
  return {
    chatThreads: [
      {
        id: THREAD_ID,
        agentId: AGENT_ID,
        title: THREAD_TITLE,
        sortAt: "2026-03-10T00:00:02Z",
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:02Z",
        pinnedAt: null,
        renamedAt: null,
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
      },
    ],
    latestEventId: null,
    latestSeqId: null,
  };
}

function mockSidebarThread(): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, currentThreadSnapshot());
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
}

function trackActiveAgentError(): () => boolean {
  let logged = false;
  setLogErrorHandler((loggerName, args) => {
    const [message, error] = args;
    if (
      loggerName === "Promise" &&
      message === "Detached promise rejected [dom_callback]" &&
      error instanceof Error &&
      error.message === "Chat thread requires an active agent"
    ) {
      logged = true;
    }
  });
  return () => {
    return logged;
  };
}

describe("okou chat thread IndexedDB fallback", () => {
  beforeEach(async () => {
    await clearCachedChatData();
  });

  afterEach(async () => {
    await clearCachedChatData();
  });

  it("keeps the app skeleton visible until uncached thread metadata syncs", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          code: "BROWSER_NOT_FOUND",
          message: "Managed browser not found",
        },
      });
    });
    const runtimeDb = await primeRuntimeChatDb();
    const snapshotRequested = context.mocks.deferred<void>();
    const releaseSnapshot = context.mocks.deferred<void>();
    const activeAgentErrorLogged = trackActiveAgentError();
    context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
      if (!snapshotRequested.settled()) {
        snapshotRequested.resolve();
      }
      await releaseSnapshot.promise;
      return respond(200, currentThreadSnapshot());
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });

    try {
      setupChatPage();
      await snapshotRequested.promise;

      const appSkeleton = await screen.findByTestId("app-skeleton");
      expect(appSkeleton).not.toHaveAttribute("aria-hidden");
      expect(
        screen.queryByPlaceholderText(PLACEHOLDER),
      ).not.toBeInTheDocument();
      expect(activeAgentErrorLogged()).toBeFalsy();

      releaseSnapshot.resolve();

      await expect(
        screen.findByPlaceholderText(PLACEHOLDER),
      ).resolves.toBeInTheDocument();
      await waitFor(() => {
        expect(appSkeleton).toHaveAttribute("aria-hidden", "true");
      });
      expect(activeAgentErrorLogged()).toBeFalsy();
    } finally {
      if (!releaseSnapshot.settled()) {
        releaseSnapshot.resolve();
      }
      runtimeDb.close();
    }
  });

  it("shows chat thread not found after remote metadata sync confirms a miss", async () => {
    const runtimeDb = await primeRuntimeChatDb();
    const snapshotRequested = context.mocks.deferred<void>();
    const releaseSnapshot = context.mocks.deferred<void>();
    const activeAgentErrorLogged = trackActiveAgentError();
    context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
      snapshotRequested.resolve();
      await releaseSnapshot.promise;
      return respond(200, {
        chatThreads: [],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });

    try {
      setupChatPage();
      await snapshotRequested.promise;

      const appSkeleton = await screen.findByTestId("app-skeleton");
      expect(appSkeleton).not.toHaveAttribute("aria-hidden");
      expect(
        screen.queryByRole("heading", { name: "Chat thread not found" }),
      ).not.toBeInTheDocument();

      releaseSnapshot.resolve();

      await expect(
        screen.findByRole("heading", { name: "Chat thread not found" }),
      ).resolves.toBeInTheDocument();
      expect(appSkeleton).toHaveAttribute("aria-hidden", "true");
      expect(
        screen.queryByPlaceholderText(PLACEHOLDER),
      ).not.toBeInTheDocument();
      expect(activeAgentErrorLogged()).toBeFalsy();
    } finally {
      if (!releaseSnapshot.settled()) {
        releaseSnapshot.resolve();
      }
      runtimeDb.close();
    }
  });

  it("keeps a notification-opened thread pending until foreground metadata catch-up", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => {
      return visibilityState;
    });

    prepareDefaultAgent();
    mockCurrentThreadDetail();
    context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          code: "BROWSER_NOT_FOUND",
          message: "Managed browser not found",
        },
      });
    });
    const runtimeDb = await primeRuntimeChatDb();
    let notificationThreadAvailable = false;
    let snapshotRequests = 0;
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      snapshotRequests += 1;
      return respond(200, {
        chatThreads: [
          {
            id: OTHER_THREAD_ID,
            agentId: AGENT_ID,
            title: OTHER_THREAD_TITLE,
            sortAt: "2026-08-11T07:00:00.000Z",
            createdAt: "2026-08-11T07:00:00.000Z",
            updatedAt: "2026-08-11T07:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
          ...(notificationThreadAvailable
            ? [
                {
                  id: THREAD_ID,
                  agentId: AGENT_ID,
                  title: "Notification thread",
                  sortAt: "2026-08-11T08:00:00.000Z",
                  createdAt: "2026-08-11T08:00:00.000Z",
                  updatedAt: "2026-08-11T08:00:00.000Z",
                  pinnedAt: null,
                  renamedAt: null,
                  selectedModel: null,
                  serviceTier: null,
                  computerUseHostId: null,
                },
              ]
            : []),
        ],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });

    try {
      detachedSetupPage({
        context,
        path: `/chats/${OTHER_THREAD_ID}`,
        user: { id: IDB_USER_ID, fullName: "Test User" },
        org: {
          activeOrg: { id: IDB_ORG_ID, name: "Default Org" },
          memberships: [{ id: IDB_ORG_ID }],
        },
      });

      await expect(
        screen.findByPlaceholderText(PLACEHOLDER),
      ).resolves.toBeInTheDocument();
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${OTHER_THREAD_ID}"]`,
        ),
      ).not.toBeNull();
      const completedSnapshotRequests = snapshotRequests;
      expect(completedSnapshotRequests).toBeGreaterThan(0);

      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      notificationThreadAvailable = true;
      context.store.set(navigateToChat$, THREAD_ID);

      expect(
        screen.queryByRole("heading", { name: "Chat thread not found" }),
      ).not.toBeInTheDocument();
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${OTHER_THREAD_ID}"]`,
        ),
      ).not.toBeNull();
      expect(snapshotRequests).toBe(completedSnapshotRequests);

      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));

      await waitFor(() => {
        expect(
          document.querySelector(
            `[data-chat-thread-container-id="${THREAD_ID}"]`,
          ),
        ).not.toBeNull();
      });
      expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
        "Notification thread",
      );
      expect(
        screen.queryByRole("heading", { name: "Chat thread not found" }),
      ).not.toBeInTheDocument();
      expect(snapshotRequests).toBeGreaterThan(completedSnapshotRequests);
    } finally {
      runtimeDb.close();
    }
  });

  it("renders from cached thread metadata without waiting for remote sync", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    const runtimeDb = await primeRuntimeChatDb();
    await runtimeDb.put(CHAT_THREAD_SNAPSHOT_STORE, {
      id: "current",
      ...currentThreadSnapshot(),
      latestEventId: "00000000-0000-4000-8000-000000000001",
      latestSeqId: 1,
    });
    const remoteEventsRequested = context.mocks.deferred<void>();
    const releaseRemoteEvents = context.mocks.deferred<void>();
    const activeAgentErrorLogged = trackActiveAgentError();
    context.mocks.api(chatThreadsContract.events, async ({ respond }) => {
      remoteEventsRequested.resolve();
      await releaseRemoteEvents.promise;
      return respond(200, { events: [], hasMore: false });
    });

    try {
      setupChatPage();
      await remoteEventsRequested.promise;

      await expect(
        screen.findByPlaceholderText(PLACEHOLDER),
      ).resolves.toBeInTheDocument();
      expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(releaseRemoteEvents.settled()).toBeFalsy();
      expect(activeAgentErrorLogged()).toBeFalsy();
    } finally {
      if (!releaseRemoteEvents.settled()) {
        releaseRemoteEvents.resolve();
      }
      runtimeDb.close();
    }
  });

  it("renders IndexedDB rows without an empty state while mark-read is blocked", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    const runtimeDb = await primeRuntimeChatDb();
    const runId = "run-cached-mark-read";
    const cachedMessage = "Cached while mark-read is pending";
    const cachedRows = [
      {
        id: "00000000-0000-4000-8000-000000000151",
        chatThreadId: THREAD_ID,
        runId,
        revokesEventId: null,
        eventType: "output.message",
        payload: { content: cachedMessage },
        contextType: null,
        contextId: null,
        runEventSequenceNumber: null,
        runEventId: null,
        seqId: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000152",
        chatThreadId: THREAD_ID,
        runId,
        revokesEventId: null,
        eventType: "run.completed",
        payload: null,
        contextType: null,
        contextId: null,
        runEventSequenceNumber: null,
        runEventId: null,
        seqId: 2,
        createdAt: "2026-03-10T00:00:02Z",
      },
    ] satisfies ChatEventRowV4[];
    await Promise.all(
      cachedRows.map((row) => {
        return runtimeDb.put(CHAT_EVENT_ROWS_STORE, row);
      }),
    );

    const markReadStarted = context.mocks.deferred<void>();
    const releaseMarkRead = context.mocks.deferred<void>();
    context.mocks.api(
      chatThreadMarkReadContract.markRead,
      async ({ respond }) => {
        markReadStarted.resolve();
        await releaseMarkRead.promise;
        return respond(200, {
          lastReadAt: "2026-03-10T00:00:02Z",
          unreads: [],
        });
      },
    );
    context.mocks.api(chatThreadEventsContract.rows, ({ respond }) => {
      return respond(200, { rows: [] });
    });
    context.mocks.api(chatThreadEventsContract.list, () => {
      throw new Error("projected events endpoint must not be called");
    });
    const emptyThread = observeEmptyThreadMessage();

    try {
      setupChatPage();
      await markReadStarted.promise;

      await expect(
        screen.findByText(cachedMessage),
      ).resolves.toBeInTheDocument();
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
      expect(screen.queryByText(EMPTY_THREAD_MESSAGE)).not.toBeInTheDocument();
      expect(emptyThread.wasShown()).toBeFalsy();
      expect(releaseMarkRead.settled()).toBeFalsy();
    } finally {
      emptyThread.disconnect();
      if (!releaseMarkRead.settled()) {
        releaseMarkRead.resolve();
      }
      runtimeDb.close();
    }
  });

  it("renders remote rows without an empty state while mark-read is blocked", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    const runtimeDb = await primeRuntimeChatDb();
    const snapshotUrl =
      "https://r2.example.com/chat-events/loading-handoff.ndjson.gz";
    const snapshotBodyRequested = context.mocks.deferred<void>();
    const releaseSnapshotBody = context.mocks.deferred<void>();
    const markReadStarted = context.mocks.deferred<void>();
    const releaseMarkRead = context.mocks.deferred<void>();
    const runId = "run-remote-mark-read";
    const snapshotRows = [
      {
        id: "00000000-0000-4000-8000-000000000201",
        chatThreadId: THREAD_ID,
        runId: null,
        revokesEventId: null,
        eventType: "input.prompt",
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: USER_MESSAGE }],
          },
        },
        contextType: "web",
        contextId: null,
        runEventSequenceNumber: null,
        runEventId: null,
        seqId: 1,
        createdAt: "2026-08-12T06:22:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000202",
        chatThreadId: THREAD_ID,
        runId,
        revokesEventId: null,
        eventType: "output.message",
        payload: { content: ASSISTANT_MESSAGE },
        contextType: null,
        contextId: null,
        runEventSequenceNumber: null,
        runEventId: null,
        seqId: 2,
        createdAt: "2026-08-12T06:22:01.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000203",
        chatThreadId: THREAD_ID,
        runId,
        revokesEventId: null,
        eventType: "run.completed",
        payload: null,
        contextType: null,
        contextId: null,
        runEventSequenceNumber: null,
        runEventId: null,
        seqId: 3,
        createdAt: "2026-08-12T06:22:02.000Z",
      },
    ] satisfies ChatEventRowV4[];

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: snapshotUrl,
        expiresInSeconds: 900,
        lastSeqId: 3,
      });
    });
    context.mocks.http.get(snapshotUrl, async () => {
      snapshotBodyRequested.resolve();
      await releaseSnapshotBody.promise;
      return new Response(
        `${snapshotRows
          .map((row) => {
            return JSON.stringify(row);
          })
          .join("\n")}\n`,
      );
    });
    context.mocks.api(chatThreadEventsContract.rows, ({ respond }) => {
      return respond(200, { rows: [] });
    });
    context.mocks.api(chatThreadEventsContract.list, () => {
      throw new Error("projected events endpoint must not be called");
    });
    context.mocks.api(
      chatThreadMarkReadContract.markRead,
      async ({ respond }) => {
        markReadStarted.resolve();
        await releaseMarkRead.promise;
        return respond(200, {
          lastReadAt: "2026-08-12T06:22:02.000Z",
          unreads: [],
        });
      },
    );

    let uncoveredLoadingGap = false;
    const observer = new MutationObserver(() => {
      if (
        document.querySelector("[data-chat-skeleton]") === null &&
        screen.queryByText(USER_MESSAGE) === null
      ) {
        uncoveredLoadingGap = true;
      }
    });
    const emptyThread = observeEmptyThreadMessage();
    try {
      setupChatPage();
      await snapshotBodyRequested.promise;

      await waitFor(() => {
        expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      releaseSnapshotBody.resolve();
      await markReadStarted.promise;

      await expect(
        screen.findByText(USER_MESSAGE),
      ).resolves.toBeInTheDocument();
      await expect(
        screen.findByText(ASSISTANT_MESSAGE),
      ).resolves.toBeInTheDocument();
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
      expect(screen.queryByText(EMPTY_THREAD_MESSAGE)).not.toBeInTheDocument();
      expect(emptyThread.wasShown()).toBeFalsy();
      expect(uncoveredLoadingGap).toBeFalsy();
      expect(releaseMarkRead.settled()).toBeFalsy();
    } finally {
      observer.disconnect();
      emptyThread.disconnect();
      if (!releaseSnapshotBody.settled()) {
        releaseSnapshotBody.resolve();
      }
      if (!releaseMarkRead.settled()) {
        releaseMarkRead.resolve();
      }
      runtimeDb.close();
    }
  });
});
