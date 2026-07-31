import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "../../../signals/external/chat-idb-schema.ts";
import {
  chatIdb$,
  openChatIdb,
} from "../../../signals/external/chat-idb-store.ts";
import { CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY } from "../../../signals/chat-page/chat-thread-sidebar-layout.ts";
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
const IDB_USER_ID = "zero-chat-thread-idb-user";
const IDB_ORG_ID = "zero-chat-thread-idb-org";
const CHAT_VIEWPORT_HEIGHT = 300;
const CHAT_SCROLL_HEIGHT = 1000;
const PAGE_LOAD_TIMEOUT_MS = 5000;

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
  mockUser({ id: IDB_USER_ID, fullName: "Test User" }, { token: "test-token" });
  mockOrganization({
    activeOrg: { id: IDB_ORG_ID, name: "Default Org" },
    memberships: [{ id: IDB_ORG_ID }],
  });
  return await context.store.get(chatIdb$);
}

function setupChatPage({
  autoOpenEnabled = false,
}: {
  readonly autoOpenEnabled?: boolean;
} = {}): void {
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    user: { id: IDB_USER_ID, fullName: "Test User" },
    org: {
      activeOrg: { id: IDB_ORG_ID, name: "Default Org" },
      memberships: [{ id: IDB_ORG_ID }],
    },
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadSidebarAutoOpen]: autoOpenEnabled,
      [FeatureSwitchKey.ZeroBrowser]: true,
    },
  });
}

async function clearCachedChatData(): Promise<void> {
  const db = await openChatIdb(IDB_USER_ID, IDB_ORG_ID);
  try {
    const tx = db.transaction(
      [
        CHAT_MESSAGES_STORE,
        CHAT_THREAD_SNAPSHOT_STORE,
        CHAT_THREAD_EVENTS_STORE,
        CHAT_THREAD_EVENT_SYNC_STORE,
      ],
      "readwrite",
    );
    const messagesStore = tx.objectStore(CHAT_MESSAGES_STORE);
    const threadSnapshotStore = tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE);
    const threadEventsStore = tx.objectStore(CHAT_THREAD_EVENTS_STORE);
    const threadEventSyncStore = tx.objectStore(CHAT_THREAD_EVENT_SYNC_STORE);
    const clearMessages = messagesStore.clear.bind(messagesStore);
    const clearThreadSnapshot =
      threadSnapshotStore.clear.bind(threadSnapshotStore);
    const clearThreadEvents = threadEventsStore.clear.bind(threadEventsStore);
    const clearThreadEventSync =
      threadEventSyncStore.clear.bind(threadEventSyncStore);
    await Promise.all([
      clearMessages(),
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
    });
  });
}

function mockSidebarThread(): void {
  const thread = {
    id: THREAD_ID,
    title: THREAD_TITLE,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:02Z",
    pinnedAt: null,
  };
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: thread.id,
          agentId: thread.agent.id,
          title: thread.title,
          sortAt: thread.updatedAt,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          pinnedAt: thread.pinnedAt,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        },
      ],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
}

describe("zero chat thread IndexedDB fallback", () => {
  beforeEach(async () => {
    await clearCachedChatData();
  });

  afterEach(async () => {
    await clearCachedChatData();
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

    try {
      setupChatPage({ autoOpenEnabled: true });
      await catchUpRequested.promise;

      await expect(
        screen.findByText("Cached initial deck"),
      ).resolves.toBeInTheDocument();
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    } finally {
      if (!releaseCatchUp.settled()) {
        releaseCatchUp.resolve();
      }
      runtimeDb.close();
    }
  });

  it("scrolls cached messages to the bottom while remote catch-up is blocked", async () => {
    const user = userEvent.setup({ delay: null });
    prepareDefaultAgent();
    installChatScrollLayout();

    const runtimeDb = await primeRuntimeChatDb();
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
          if (query.sinceSeqId || query.sinceId) {
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
        if (query.sinceSeqId || query.sinceId) {
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

    try {
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
    } finally {
      if (!releaseCatchUp.settled()) {
        releaseCatchUp.resolve();
      }
      runtimeDb.close();
    }
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
      eventType: "browser.started",
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
            eventType: "browser.stopped",
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

    try {
      setupChatPage({ autoOpenEnabled: true });

      await expect(
        screen.findByText("Browser stopped remotely", undefined, {
          timeout: PAGE_LOAD_TIMEOUT_MS,
        }),
      ).resolves.toBeInTheDocument();
      expect(
        document.querySelector("[data-browser-session-sidebar]"),
      ).toBeInstanceOf(HTMLElement);
    } finally {
      runtimeDb.close();
    }
  });

  it("falls back to remote messages when IndexedDB has no cached events", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    const runtimeDb = await primeRuntimeChatDb();

    const messageListRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
      messageListRequested.resolve();
      if (query.sinceSeqId || query.sinceId) {
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

    try {
      setupChatPage();
      await messageListRequested.promise;

      await waitFor(() => {
        expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
      });

      const messageContainer = document.querySelector(
        "[data-message-container]",
      );
      expect(messageContainer).toBeInstanceOf(HTMLElement);
      await expect(
        screen.findByText(USER_MESSAGE),
      ).resolves.toBeInTheDocument();
      await expect(
        screen.findByText(ASSISTANT_MESSAGE),
      ).resolves.toBeInTheDocument();
      expect(
        screen.queryByText("Send a message to start the conversation"),
      ).not.toBeInTheDocument();
    } finally {
      runtimeDb.close();
    }
  });

  it("shows the message skeleton until an uncached remote thread is confirmed empty", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();
    const runtimeDb = await primeRuntimeChatDb();

    const initialMessageList = context.mocks.deferred<void>();
    const messageListRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadEventsContract.list, async ({ respond }) => {
      messageListRequested.resolve();
      await initialMessageList.promise;
      return respond(200, { events: [] });
    });

    try {
      setupChatPage();
      await messageListRequested.promise;

      await waitFor(() => {
        expect(document.querySelector("[data-chat-skeleton]")).toBeInstanceOf(
          HTMLElement,
        );
      });
      expect(
        screen.queryByText("Send a message to start the conversation"),
      ).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();

      initialMessageList.resolve();
      await waitFor(() => {
        expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
        expect(
          screen.getByText("Send a message to start the conversation"),
        ).toBeInTheDocument();
      });
    } finally {
      if (!initialMessageList.settled()) {
        initialMessageList.resolve();
      }
      runtimeDb.close();
    }
  });
});
