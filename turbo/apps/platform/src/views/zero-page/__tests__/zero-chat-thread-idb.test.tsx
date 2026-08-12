import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatEventRowV4 } from "@vm0/api-contracts/contracts/chat-event-rows";
import {
  chatThreadArtifactsContract,
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroBrowserContract } from "@vm0/api-contracts/contracts/zero-browser";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockOrganization, mockUser } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_MESSAGES_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "../../../signals/external/chat-idb-schema.ts";
import {
  chatIdb$,
  openChatIdb,
} from "../../../signals/external/chat-idb-store.ts";
import { setLogErrorHandler } from "../../../signals/log.ts";
import { CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY } from "../../../signals/chat-page/chat-thread-sidebar-layout.ts";
import { navigateToChat$ } from "../../../signals/zero-page/zero-nav.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

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
const CHAT_VIEWPORT_HEIGHT = 300;
const CHAT_SCROLL_HEIGHT = 1000;
const PAGE_LOAD_TIMEOUT_MS = 5000;

function idbUserId(): string {
  return `zero-chat-thread-idb-user-${context.resourceId}`;
}

function idbOrgId(): string {
  return `zero-chat-thread-idb-org-${context.resourceId}`;
}

function isChatScrollContainer(element: HTMLElement): boolean {
  return Object.hasOwn(element.dataset, "scrollContainer");
}

function installChatScrollLayout(): void {
  const scrollTopByContainer = new WeakMap<HTMLElement, number>();

  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
    function getScrollTop(this: HTMLElement): number {
      if (!isChatScrollContainer(this)) {
        return 0;
      }
      return scrollTopByContainer.get(this) ?? 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
    function setScrollTop(this: HTMLElement, value: number): void {
      if (!isChatScrollContainer(this)) {
        return;
      }
      const maxScrollTop = CHAT_SCROLL_HEIGHT - CHAT_VIEWPORT_HEIGHT;
      scrollTopByContainer.set(
        this,
        Math.max(0, Math.min(value, maxScrollTop)),
      );
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function getScrollHeight(this: HTMLElement): number {
      return isChatScrollContainer(this) ? CHAT_SCROLL_HEIGHT : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function getClientHeight(this: HTMLElement): number {
      return isChatScrollContainer(this) ? CHAT_VIEWPORT_HEIGHT : 0;
    },
  );
}

function chatScrollContainer(): HTMLElement {
  const container = document.querySelector("[data-scroll-container]");
  if (!(container instanceof HTMLElement)) {
    throw new Error("Chat scroll container not found");
  }
  return container;
}

async function findThreadLink(title: string): Promise<HTMLAnchorElement> {
  const link = (await screen.findByText(title)).closest("a");
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Thread link not found: ${title}`);
  }
  return link;
}

async function primeRuntimeChatDb(): Promise<
  Awaited<ReturnType<typeof openChatIdb>>
> {
  mockUser({ id: idbUserId(), fullName: "Test User" }, { token: "test-token" });
  mockOrganization({
    activeOrg: { id: idbOrgId(), name: "Default Org" },
    memberships: [{ id: idbOrgId() }],
  });
  const db = await context.store.get(chatIdb$);
  context.signal.addEventListener(
    "abort",
    () => {
      db.close();
    },
    { once: true },
  );
  return db;
}

function setupChatPage(
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>,
): void {
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    user: { id: idbUserId(), fullName: "Test User" },
    org: {
      activeOrg: { id: idbOrgId(), name: "Default Org" },
      memberships: [{ id: idbOrgId() }],
    },
    featureSwitches,
  });
}

function prepareDefaultAgent(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: idbUserId(),
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
    await primeRuntimeChatDb();
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

    setupChatPage();
    await snapshotRequested.promise;

    const appSkeleton = await screen.findByTestId("app-skeleton");
    expect(appSkeleton).not.toHaveAttribute("aria-hidden");
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
    expect(activeAgentErrorLogged()).toBeFalsy();

    releaseSnapshot.resolve();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(appSkeleton).toHaveAttribute("aria-hidden", "true");
    });
    expect(activeAgentErrorLogged()).toBeFalsy();
  });

  it("shows chat thread not found after remote metadata sync confirms a miss", async () => {
    await primeRuntimeChatDb();
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
    context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          code: "BROWSER_NOT_FOUND",
          message: "Managed browser not found",
        },
      });
    });
    await primeRuntimeChatDb();
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
  });

  it("shows cached messages without auto-opening their artifact before remote catch-up", async () => {
    const cachedUrl = "https://cached-initial-deck.sites.vm7.io";
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: [] });
    });

    const runtimeDb = await primeRuntimeChatDb();
    await runtimeDb.put(CHAT_MESSAGES_STORE, {
      id: "00000000-0000-4000-8000-000000000091",
      threadId: THREAD_ID,
      eventType: "output.message",
      content: `[Cached initial deck](${cachedUrl})`,
      runId: "run-cached-initial",
      seqId: 1,
      createdAt: "2026-03-10T00:00:01Z",
    });
    await runtimeDb.put(CHAT_MESSAGES_STORE, {
      id: "00000000-0000-4000-8000-000000000092",
      threadId: THREAD_ID,
      eventType: "run.completed",
      content: null,
      runId: "run-cached-initial",
      runLifecycleEvent: "completed",
      seqId: 2,
      createdAt: "2026-03-10T00:00:02Z",
    });

    const catchUpRequested = context.mocks.deferred<void>();
    const releaseCatchUp = context.mocks.deferred<void>();
    context.mocks.api(chatThreadEventsContract.list, async ({ respond }) => {
      catchUpRequested.resolve();
      await releaseCatchUp.promise;
      return respond(200, { events: [] });
    });

    setupChatPage();
    await catchUpRequested.promise;

    await expect(
      screen.findByText("Cached initial deck"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });

  it("shows cached messages when a realtime subscription fails", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();

    const runtimeDb = await primeRuntimeChatDb();
    await runtimeDb.put(CHAT_MESSAGES_STORE, {
      id: "00000000-0000-4000-8000-000000000093",
      threadId: THREAD_ID,
      eventType: "output.message",
      content: "Cached while realtime is unavailable",
      seqId: 1,
      createdAt: "2026-03-10T00:00:01Z",
    });
    const realtimeSubscriptionFailed = context.mocks.ably.rejectSubscribe(
      `chatThreadDetailChanged:${THREAD_ID}`,
      "channel attach failed",
    );
    let remoteEventRequests = 0;
    context.mocks.api(chatThreadEventsContract.list, ({ respond }) => {
      remoteEventRequests += 1;
      return respond(200, { events: [] });
    });

    setupChatPage();
    await realtimeSubscriptionFailed;

    await expect(
      screen.findByText("Cached while realtime is unavailable"),
    ).resolves.toBeInTheDocument();
    expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    expect(remoteEventRequests).toBe(0);
  });

  it("scrolls cached messages to the bottom while remote catch-up is blocked", async () => {
    const user = userEvent.setup({ delay: null });
    prepareDefaultAgent();
    installChatScrollLayout();

    await primeRuntimeChatDb();
    const initialCatchUpCompleted = context.mocks.deferred<void>();
    const catchUpRequested = context.mocks.deferred<void>();
    const releaseCatchUp = context.mocks.deferred<void>();
    let blockCurrentCatchUp = false;
    const lifecycle = mockChatLifecycle(context, {
      threadId: THREAD_ID,
      threadTitle: THREAD_TITLE,
    });
    lifecycle.setThreadList([
      {
        id: THREAD_ID,
        title: THREAD_TITLE,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:01:00Z",
      },
      {
        id: OTHER_THREAD_ID,
        title: OTHER_THREAD_TITLE,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.api(
      chatThreadEventsContract.list,
      async ({ params, query, respond }) => {
        if (params.threadId === THREAD_ID) {
          if (blockCurrentCatchUp) {
            catchUpRequested.resolve();
            await releaseCatchUp.promise;
            return respond(200, { events: [] });
          }
          if (query.sinceSeqId) {
            initialCatchUpCompleted.resolve();
            return respond(200, { events: [] });
          }
          return respond(200, {
            events: Array.from({ length: 8 }, (_, index) => {
              return {
                id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                threadId: THREAD_ID,
                eventType: "output.message" as const,
                content: `Cached scroll message ${index}`,
                runId: `cached-scroll-run-${index}`,
                seqId: index + 1,
                createdAt: new Date(
                  Date.UTC(2026, 2, 10, 0, index),
                ).toISOString(),
              };
            }),
          });
        }
        if (query.sinceSeqId) {
          return respond(200, { events: [] });
        }
        return respond(200, {
          events: [
            {
              id: "00000000-0000-4000-8000-000000000009",
              threadId: OTHER_THREAD_ID,
              eventType: "output.message" as const,
              content: "Other cached-scroll thread",
              seqId: 1,
              createdAt: "2026-03-10T00:00:00Z",
            },
          ],
        });
      },
    );

    setupChatPage();
    await initialCatchUpCompleted.promise;
    await expect(
      screen.findByText("Cached scroll message 7"),
    ).resolves.toBeInTheDocument();

    await user.click(await findThreadLink(OTHER_THREAD_TITLE));
    await expect(
      screen.findByText("Other cached-scroll thread"),
    ).resolves.toBeInTheDocument();

    blockCurrentCatchUp = true;
    await user.click(await findThreadLink(THREAD_TITLE));
    await catchUpRequested.promise;
    await expect(
      screen.findByText("Cached scroll message 7"),
    ).resolves.toBeInTheDocument();

    await waitFor(() => {
      expect(releaseCatchUp.settled()).toBeFalsy();
      expect(chatScrollContainer().scrollTop).toBe(
        CHAT_SCROLL_HEIGHT - CHAT_VIEWPORT_HEIGHT,
      );
    });
  });

  it("keeps a sidebar opened from cached browser state when remote sync later stops it", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    context.mocks.browser.matchMedia((query) => {
      return query === CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY;
    });
    context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          code: "BROWSER_NOT_FOUND",
          message: "Managed browser not found",
        },
      });
    });

    const runtimeDb = await primeRuntimeChatDb();
    await runtimeDb.put(CHAT_MESSAGES_STORE, {
      id: "00000000-0000-4000-8000-000000000094",
      threadId: THREAD_ID,
      eventType: "browser.open",
      content: null,
      seqId: 1,
      createdAt: "2026-03-10T00:00:00Z",
    });
    context.mocks.api(chatThreadEventsContract.list, ({ respond }) => {
      return respond(200, {
        events: [
          {
            id: "00000000-0000-4000-8000-000000000095",
            threadId: THREAD_ID,
            eventType: "browser.close",
            content: null,
            seqId: 2,
            createdAt: "2026-03-10T00:00:01Z",
          },
          {
            id: "00000000-0000-4000-8000-000000000096",
            threadId: THREAD_ID,
            eventType: "output.message",
            content: "Browser stopped remotely",
            seqId: 3,
            createdAt: "2026-03-10T00:00:02Z",
          },
        ],
      });
    });

    setupChatPage();

    await expect(
      screen.findByText("Browser stopped remotely", undefined, {
        timeout: PAGE_LOAD_TIMEOUT_MS,
      }),
    ).resolves.toBeInTheDocument();
    expect(
      document.querySelector("[data-browser-session-sidebar]"),
    ).toBeInstanceOf(HTMLElement);
  });

  it("falls back to remote messages when IndexedDB has no cached events", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    await primeRuntimeChatDb();

    const messageListRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
      messageListRequested.resolve();
      if (query.sinceSeqId) {
        return respond(200, { events: [] });
      }
      return respond(200, {
        events: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            threadId: THREAD_ID,
            eventType: "input.prompt" as const,
            content: null,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: USER_MESSAGE }],
            },
            seqId: 1,
            createdAt: "2026-03-10T00:00:01Z",
          },
          {
            id: "00000000-0000-4000-8000-000000000102",
            threadId: THREAD_ID,
            eventType: "output.message" as const,
            content: ASSISTANT_MESSAGE,
            seqId: 2,
            createdAt: "2026-03-10T00:00:02Z",
          },
        ],
      });
    });

    setupChatPage();
    await messageListRequested.promise;

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    const messageContainer = document.querySelector("[data-message-container]");
    expect(messageContainer).toBeInstanceOf(HTMLElement);
    await expect(screen.findByText(USER_MESSAGE)).resolves.toBeInTheDocument();
    await expect(
      screen.findByText(ASSISTANT_MESSAGE),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Send a message to start the conversation"),
    ).not.toBeInTheDocument();
  });

  it("treats an event type unknown to the client as an IndexedDB cache miss", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    const runtimeDb = await primeRuntimeChatDb();
    await runtimeDb.put(CHAT_MESSAGES_STORE, {
      id: "00000000-0000-4000-8000-000000000104",
      threadId: THREAD_ID,
      eventType: "input.future-budget",
      content: null,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Unsupported cached input" }],
      },
      runId: "run-unsupported-cached-input",
      seqId: 1,
      createdAt: "2026-03-10T00:00:01Z",
    });

    const messageListRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadEventsContract.list, ({ respond }) => {
      messageListRequested.resolve();
      return respond(200, {
        events: [
          {
            id: "00000000-0000-4000-8000-000000000105",
            threadId: THREAD_ID,
            eventType: "input.prompt",
            content: null,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: USER_MESSAGE }],
            },
            seqId: 1,
            createdAt: "2026-03-10T00:00:01Z",
          },
          {
            id: "00000000-0000-4000-8000-000000000106",
            threadId: THREAD_ID,
            eventType: "output.message",
            content: ASSISTANT_MESSAGE,
            seqId: 2,
            createdAt: "2026-03-10T00:00:02Z",
          },
        ],
      });
    });

    setupChatPage();
    await messageListRequested.promise;

    await expect(screen.findByText(USER_MESSAGE)).resolves.toBeInTheDocument();
    await expect(
      screen.findByText(ASSISTANT_MESSAGE),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Unsupported cached input"),
    ).not.toBeInTheDocument();
  });

  it("hides the message skeleton when IndexedDB loads any cached event", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    const runtimeDb = await primeRuntimeChatDb();
    await runtimeDb.put(CHAT_MESSAGES_STORE, {
      id: "00000000-0000-4000-8000-000000000103",
      threadId: THREAD_ID,
      eventType: "usage.recorded",
      runId: "run-cached-usage",
      content: null,
      usage: {
        version: 1,
        totalCredits: 1,
        settledAt: "2026-03-10T00:00:01Z",
        breakdown: [],
      },
      seqId: 1,
      createdAt: "2026-03-10T00:00:01Z",
    });

    const initialMessageList = context.mocks.deferred<void>();
    const messageListRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadEventsContract.list, async ({ respond }) => {
      messageListRequested.resolve();
      await initialMessageList.promise;
      return respond(200, { events: [] });
    });

    setupChatPage();
    await messageListRequested.promise;

    await waitFor(() => {
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    });
  });

  it("shows the message skeleton until the initial remote event request resolves", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    await primeRuntimeChatDb();

    const initialMessageList = context.mocks.deferred<void>();
    const messageListRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadEventsContract.list, async ({ respond }) => {
      messageListRequested.resolve();
      await initialMessageList.promise;
      return respond(200, { events: [] });
    });

    setupChatPage();
    await messageListRequested.promise;

    await waitFor(() => {
      expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
    });
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();

    initialMessageList.resolve();
    await waitFor(() => {
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
      expect(
        screen.getByText("Send a message to start the conversation"),
      ).toBeInTheDocument();
    });
  });

  it("keeps the skeleton visible through the snapshot render handoff", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    await primeRuntimeChatDb();
    const snapshotUrl =
      "https://r2.example.com/chat-events/loading-handoff.ndjson.gz";
    const snapshotBodyRequested = context.mocks.deferred<void>();
    const releaseSnapshotBody = context.mocks.deferred<void>();
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
        runId: null,
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
    ] satisfies ChatEventRowV4[];

    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
      return respond(200, {
        url: snapshotUrl,
        expiresInSeconds: 900,
        lastSeqId: 2,
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
    setupChatPage({ [FeatureSwitchKey.ChatEventSnapshotRead]: true });
    await snapshotBodyRequested.promise;

    await waitFor(() => {
      expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    releaseSnapshotBody.resolve();

    await expect(screen.findByText(USER_MESSAGE)).resolves.toBeInTheDocument();
    await expect(
      screen.findByText(ASSISTANT_MESSAGE),
    ).resolves.toBeInTheDocument();
    expect(uncoveredLoadingGap).toBeFalsy();
  });
});
