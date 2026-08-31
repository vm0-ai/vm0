import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadMarkReadContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_EVENT_CURSOR_STORE,
  CHAT_EVENT_ROWS_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "../../../signals/external/chat-idb-schema.ts";
import { openChatIdb } from "../../../signals/external/chat-idb-store.ts";
import { setLogErrorHandler } from "../../../signals/log.ts";
import { navigateToChat$ } from "../../../signals/okou-page/nav.ts";
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
const EMPTY_THREAD_MESSAGE = "Send a message to start the conversation";

function observeEmptyThreadMessage(): {
  readonly wasShown: () => boolean;
} {
  let wasShown = false;
  const record = () => {
    if (document.body.textContent?.includes(EMPTY_THREAD_MESSAGE)) {
      wasShown = true;
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(document.body, { childList: true, subtree: true });
  context.signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
    },
    { once: true },
  );
  record();
  return {
    wasShown: () => {
      return wasShown;
    },
  };
}

function idbUserId(): string {
  return `zero-chat-thread-idb-user-${context.resourceId}`;
}

function idbOrgId(): string {
  return `zero-chat-thread-idb-org-${context.resourceId}`;
}

async function primeChatDb(): Promise<Awaited<ReturnType<typeof openChatIdb>>> {
  // Seed the same user/org-scoped database that production opens after
  // bootstrap. Opening it directly keeps pre-render fixture setup from
  // reading auth signals before setupPage has run the bootstrap lifecycle.
  const db = await openChatIdb(idbUserId(), idbOrgId());
  context.signal.addEventListener(
    "abort",
    () => {
      db.close();
    },
    { once: true },
  );
  return db;
}

function setupChatPage(): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    user: { id: idbUserId(), fullName: "Test User" },
    org: {
      activeOrg: { id: idbOrgId(), name: "Default Org" },
      memberships: [{ id: idbOrgId() }],
    },
  });
}

function prepareDefaultAgent(): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: idbUserId(),
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
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
  it("shows chat thread not found after remote metadata sync confirms a miss", async () => {
    await primeChatDb();
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

    setupChatPage();
    await snapshotRequested.promise;

    const appSkeleton = await screen.findByTestId("app-skeleton");
    expect(appSkeleton).not.toHaveAttribute("aria-hidden");
    expect(
      screen.queryByRole("heading", { name: "Chat thread not found" }),
    ).not.toBeInTheDocument();
    await screen.findAllByRole("navigation", { name: "Sidebar" });

    releaseSnapshot.resolve();

    await expect(
      screen.findByRole("heading", { name: "Chat thread not found" }),
    ).resolves.toBeInTheDocument();
    expect(appSkeleton).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
    expect(activeAgentErrorLogged()).toBeFalsy();
  });

  it("keeps a notification-opened thread pending until foreground metadata catch-up", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => {
      return visibilityState;
    });

    prepareDefaultAgent();
    mockCurrentThreadDetail();
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          code: "BROWSER_NOT_FOUND",
          message: "Managed browser not found",
        },
      });
    });
    await primeChatDb();
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

    detachedSetupPage({
      context,
      path: `/chats/${OTHER_THREAD_ID}`,
      user: { id: idbUserId(), fullName: "Test User" },
      org: {
        activeOrg: { id: idbOrgId(), name: "Default Org" },
        memberships: [{ id: idbOrgId() }],
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
  });

  it("keeps cached thread shell behind the app skeleton during initial event sync", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    let metadataRequests = 0;
    context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
      metadataRequests += 1;
      return respond(404, {
        error: {
          code: "CHAT_THREAD_NOT_FOUND",
          message: "Chat thread not found",
        },
      });
    });
    const runtimeDb = await primeChatDb();
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

    setupChatPage();
    await remoteEventsRequested.promise;

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("app-skeleton")).not.toHaveAttribute(
      "aria-hidden",
    );
    expect(releaseRemoteEvents.settled()).toBeFalsy();
    expect(metadataRequests).toBe(0);
    expect(activeAgentErrorLogged()).toBeFalsy();
  });

  it("replaces stale cached metadata after an expired cursor rebase", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    let metadataRequests = 0;
    context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
      metadataRequests += 1;
      return respond(404, {
        error: {
          code: "CHAT_THREAD_NOT_FOUND",
          message: "Chat thread not found",
        },
      });
    });
    const runtimeDb = await primeChatDb();
    await runtimeDb.put(CHAT_THREAD_SNAPSHOT_STORE, {
      id: "current",
      ...currentThreadSnapshot(),
      latestEventId: "00000000-0000-4000-8000-000000000001",
      latestSeqId: 1,
    });
    const rebaseSnapshotRequested = context.mocks.deferred<void>();
    const releaseRebaseSnapshot = context.mocks.deferred<void>();
    let returnedExpiredCursor = false;
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      if (query.sinceSeqId === 1 && !returnedExpiredCursor) {
        returnedExpiredCursor = true;
        return respond(410, {
          error: {
            code: "CHAT_THREAD_EVENTS_EXPIRED",
            message: "Chat thread events cursor has expired",
          },
        });
      }
      return respond(200, { events: [], hasMore: false });
    });
    context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
      rebaseSnapshotRequested.resolve();
      await releaseRebaseSnapshot.promise;
      return respond(200, {
        chatThreads: [],
        latestEventId: null,
        latestSeqId: null,
      });
    });

    setupChatPage();
    await rebaseSnapshotRequested.promise;

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      THREAD_TITLE,
    );
    expect(metadataRequests).toBe(0);
    expect(releaseRebaseSnapshot.settled()).toBeFalsy();
    await screen.findAllByRole("navigation", { name: "Sidebar" });

    releaseRebaseSnapshot.resolve();

    await expect(
      screen.findByRole("heading", { name: "Chat thread not found" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
  });

  it("renders IndexedDB rows without an empty state while mark-read is blocked", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    const runtimeDb = await primeChatDb();
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
    ] satisfies ChatEventRow[];
    await Promise.all(
      cachedRows.map((row) => {
        return runtimeDb.put(CHAT_EVENT_ROWS_STORE, row);
      }),
    );
    await runtimeDb.put(CHAT_EVENT_CURSOR_STORE, {
      threadId: THREAD_ID,
      schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      lastEventId: cachedRows[1].id,
      lastSeqId: cachedRows[1].seqId,
    });

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
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      return respond(200, chatEventRowsResponse([], query));
    });
    const emptyThread = observeEmptyThreadMessage();

    setupChatPage();
    await markReadStarted.promise;

    await expect(screen.findByText(cachedMessage)).resolves.toBeInTheDocument();
    expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    expect(screen.queryByText(EMPTY_THREAD_MESSAGE)).not.toBeInTheDocument();
    expect(emptyThread.wasShown()).toBeFalsy();
    expect(releaseMarkRead.settled()).toBeFalsy();
  });

  it("renders remote rows without an empty state while mark-read is blocked", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    await primeChatDb();
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
    ] satisfies ChatEventRow[];
    const terminalSnapshotRow = snapshotRows.at(-1);
    if (terminalSnapshotRow === undefined) {
      throw new Error("Expected a terminal Snapshot row");
    }

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: snapshotUrl,
        expiresInSeconds: 900,
        lastEventId: terminalSnapshotRow.id,
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
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      return respond(200, chatEventRowsResponse([], query));
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
    context.signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
    const emptyThread = observeEmptyThreadMessage();
    setupChatPage();
    await snapshotBodyRequested.promise;

    const appSkeleton = await screen.findByTestId("app-skeleton");
    expect(appSkeleton).not.toHaveAttribute("aria-hidden");
    await waitFor(() => {
      expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    releaseSnapshotBody.resolve();
    await markReadStarted.promise;

    await expect(screen.findByText(USER_MESSAGE)).resolves.toBeInTheDocument();
    await expect(
      screen.findByText(ASSISTANT_MESSAGE),
    ).resolves.toBeInTheDocument();
    expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    expect(appSkeleton).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText(EMPTY_THREAD_MESSAGE)).not.toBeInTheDocument();
    expect(emptyThread.wasShown()).toBeFalsy();
    expect(uncoveredLoadingGap).toBeFalsy();
    expect(releaseMarkRead.settled()).toBeFalsy();
  });
});
