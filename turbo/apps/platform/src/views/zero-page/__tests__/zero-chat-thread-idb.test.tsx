import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";

import { detachedSetupPage as baseDetachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

const idbMessageStoreMock = vi.hoisted(() => {
  let cachedMessages: unknown[] = [];

  const readLatestImpl = (_threadId: string, limit?: number) => {
    if (limit === undefined) {
      return Promise.resolve(cachedMessages);
    }
    return Promise.resolve(cachedMessages.slice(-limit));
  };
  const readBeforeImpl = () => {
    return Promise.resolve([]);
  };
  const messageExistsImpl = (_threadId: string, messageId: string) => {
    return Promise.resolve(
      cachedMessages.some((message) => {
        return (
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          message.id === messageId
        );
      }),
    );
  };
  const upsertMessagesImpl = (_threadId: string, messages: unknown[]) => {
    for (const message of messages) {
      if (
        typeof message !== "object" ||
        message === null ||
        !("id" in message)
      ) {
        continue;
      }
      const index = cachedMessages.findIndex((cached) => {
        return (
          typeof cached === "object" &&
          cached !== null &&
          "id" in cached &&
          cached.id === message.id
        );
      });
      if (index === -1) {
        cachedMessages.push(message);
      } else {
        cachedMessages[index] = message;
      }
    }
    return Promise.resolve();
  };
  const readLatest = vi.fn(readLatestImpl);
  const readBefore = vi.fn(readBeforeImpl);
  const messageExists = vi.fn(messageExistsImpl);
  const upsertMessages = vi.fn(upsertMessagesImpl);

  return {
    readLatest,
    readBefore,
    messageExists,
    upsertMessages,
    setMessages(messages: unknown[]) {
      cachedMessages = messages;
    },
    reset() {
      cachedMessages = [];
      readLatest.mockReset();
      readLatest.mockImplementation(readLatestImpl);
      readBefore.mockReset();
      readBefore.mockImplementation(readBeforeImpl);
      messageExists.mockReset();
      messageExists.mockImplementation(messageExistsImpl);
      upsertMessages.mockReset();
      upsertMessages.mockImplementation(upsertMessagesImpl);
    },
  };
});

const idbThreadEventStoreMock = vi.hoisted(() => {
  let snapshot: {
    readonly chatThreads: readonly ChatThreadSnapshotProjection[];
    readonly latestEventId: string | null;
  } | null = null;
  let events: readonly ChatThreadEvent[] = [];

  const readSnapshot = vi.fn(() => {
    return Promise.resolve(snapshot);
  });
  const readLatestEventId = vi.fn(() => {
    return Promise.resolve(snapshot?.latestEventId ?? null);
  });
  const readEvents = vi.fn(() => {
    return Promise.resolve(events);
  });
  const replaceFromSnapshot = vi.fn(
    (nextSnapshot: {
      readonly chatThreads: readonly ChatThreadSnapshotProjection[];
      readonly latestEventId: string | null;
    }) => {
      snapshot = nextSnapshot;
      events = [];
      return Promise.resolve();
    },
  );
  const upsertEvents = vi.fn((nextEvents: readonly ChatThreadEvent[]) => {
    const byId = new Map(
      events.map((event) => {
        return [event.id, event] as const;
      }),
    );
    for (const event of nextEvents) {
      byId.set(event.id, event);
    }
    events = [...byId.values()];
    return Promise.resolve();
  });

  return {
    readSnapshot,
    readLatestEventId,
    readEvents,
    replaceFromSnapshot,
    upsertEvents,
    setData(args: {
      readonly snapshot: {
        readonly chatThreads: readonly ChatThreadSnapshotProjection[];
        readonly latestEventId: string | null;
      } | null;
      readonly events?: readonly ChatThreadEvent[];
    }) {
      snapshot = args.snapshot;
      events = args.events ?? [];
    },
    reset() {
      snapshot = null;
      events = [];
      readSnapshot.mockClear();
      readLatestEventId.mockClear();
      readEvents.mockClear();
      replaceFromSnapshot.mockClear();
      upsertEvents.mockClear();
    },
  };
});

vi.mock("../../../signals/external/idb-message-store.ts", () => {
  return {
    createIdbMessageStores: () => {
      return {
        readStore: {
          readLatest: idbMessageStoreMock.readLatest,
          readBefore: idbMessageStoreMock.readBefore,
          messageExists: idbMessageStoreMock.messageExists,
        },
        writeStore: {
          upsertMessages: idbMessageStoreMock.upsertMessages,
        },
      };
    },
  };
});

vi.mock("../../../signals/external/idb-chat-thread-event-store.ts", () => {
  return {
    createIdbChatThreadEventStores: () => {
      return {
        readStore: {
          readSnapshot: idbThreadEventStoreMock.readSnapshot,
          readLatestEventId: idbThreadEventStoreMock.readLatestEventId,
          readEvents: idbThreadEventStoreMock.readEvents,
        },
        writeStore: {
          replaceFromSnapshot: idbThreadEventStoreMock.replaceFromSnapshot,
          upsertEvents: idbThreadEventStoreMock.upsertEvents,
        },
      };
    },
  };
});

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const THREAD_EVENT_ID = "d0000000-0000-4000-a000-000000000001";
const RUN_ID = "e0000000-0000-4000-a000-000000000001";
const THREAD_TITLE = "GEO pricing research";
const USER_MESSAGE = "Summarize the launch plan";
const ASSISTANT_MESSAGE = "Here is the result";

function detachedSetupPage(
  options: Parameters<typeof baseDetachedSetupPage>[0],
): void {
  baseDetachedSetupPage(options);
}

function prepareDefaultAgent(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
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
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      title: THREAD_TITLE,
      agentId: AGENT_ID,
      activeRunIds: [],
      lastReadAt: "2026-03-10T00:00:00Z",
      lastMessageAt: "2026-03-10T00:00:02Z",
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:02Z",
      draftContent: null,
      draftAttachments: null,
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
    running: false,
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
        },
      ],
      latestEventId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
}

function cachedChatMessages(): PagedChatMessage[] {
  return [
    {
      id: "00000000-0000-4000-8000-000000000101",
      role: "user",
      runId: RUN_ID,
      content: USER_MESSAGE,
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      role: "assistant",
      runId: RUN_ID,
      content: ASSISTANT_MESSAGE,
      createdAt: "2026-03-10T00:00:02Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      role: "assistant",
      runId: RUN_ID,
      content: null,
      runLifecycleEvent: "completed",
      createdAt: "2026-03-10T00:00:03Z",
    },
  ];
}

function seedCachedThreadEvents(): void {
  idbThreadEventStoreMock.setData({
    snapshot: {
      latestEventId: THREAD_EVENT_ID,
      chatThreads: [
        {
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Stale cached title",
          sortAt: "2026-03-10T00:00:00Z",
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          pinnedAt: null,
          renamedAt: null,
        },
      ],
    },
    events: [
      {
        id: THREAD_EVENT_ID,
        kind: "renamed",
        chatThreadId: THREAD_ID,
        agentId: AGENT_ID,
        title: THREAD_TITLE,
        createdAt: "2026-03-10T00:00:02Z",
      },
    ],
  });
}

describe("zero chat thread IndexedDB fallback", () => {
  afterEach(() => {
    idbMessageStoreMock.reset();
    idbThreadEventStoreMock.reset();
  });

  it("falls back to remote messages when IndexedDB message read never settles", async () => {
    const pendingRead = context.mocks.deferred<never[]>();
    idbMessageStoreMock.readLatest.mockImplementation(() => {
      return pendingRead.promise;
    });
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();

    let messageListRequests = 0;
    context.mocks.api(chatThreadMessagesContract.list, ({ respond }) => {
      messageListRequests += 1;
      return respond(200, {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            role: "user",
            content: USER_MESSAGE,
            createdAt: "2026-03-10T00:00:01Z",
          },
          {
            id: "00000000-0000-4000-8000-000000000102",
            role: "assistant",
            content: ASSISTANT_MESSAGE,
            createdAt: "2026-03-10T00:00:02Z",
          },
        ],
      });
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getAllByText(THREAD_TITLE).length).toBeGreaterThan(0);
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
    expect(messageListRequests).toBeGreaterThan(0);
  });

  it("keeps the chat skeleton visible while the initial message list is blocked after an IndexedDB miss", async () => {
    prepareDefaultAgent();
    mockCurrentThreadDetail();
    mockSidebarThread();

    const initialMessageList = context.mocks.deferred<void>();
    let messageListRequests = 0;
    context.mocks.api(chatThreadMessagesContract.list, async ({ respond }) => {
      messageListRequests += 1;
      await initialMessageList.promise;
      return respond(200, { messages: [], hasHistoryBefore: false });
    });

    try {
      detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

      await waitFor(() => {
        expect(messageListRequests).toBeGreaterThan(0);
        expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
      });
      expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
    } finally {
      initialMessageList.resolve();
    }
  });

  it("renders cached sidebar and chat messages while chat thread data APIs are blocked", async () => {
    prepareDefaultAgent();
    idbMessageStoreMock.setMessages(cachedChatMessages());
    seedCachedThreadEvents();

    let threadDetailRequests = 0;
    let messageListRequests = 0;
    let threadEventRequests = 0;
    context.mocks.api(chatThreadByIdContract.get, ({ never }) => {
      threadDetailRequests += 1;
      return never();
    });
    context.mocks.api(chatThreadMessagesContract.list, ({ never }) => {
      messageListRequests += 1;
      return never();
    });
    context.mocks.api(chatThreadMessagesContract.get, ({ never }) => {
      return never();
    });
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ never }) => {
      return never();
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ never }) => {
      return never();
    });
    context.mocks.api(chatThreadsContract.events, ({ never }) => {
      threadEventRequests += 1;
      return never();
    });
    context.mocks.api(chatThreadsContract.activeIds, ({ never }) => {
      return never();
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: THREAD_TITLE }),
      ).toBeInTheDocument();
      expect(screen.getAllByText(THREAD_TITLE).length).toBeGreaterThan(1);
    });
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();

    await expect(screen.findByText(USER_MESSAGE)).resolves.toBeInTheDocument();
    await expect(
      screen.findByText(ASSISTANT_MESSAGE),
    ).resolves.toBeInTheDocument();
    expect(threadDetailRequests).toBeGreaterThan(0);
    expect(messageListRequests).toBeGreaterThan(0);
    expect(threadEventRequests).toBeGreaterThan(0);
  });
});
