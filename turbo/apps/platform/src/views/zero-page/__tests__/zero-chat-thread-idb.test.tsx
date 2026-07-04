import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";

import { detachedSetupPage as baseDetachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

const idbMessageStoreMock = vi.hoisted(() => {
  const readLatest = vi.fn(() => {
    return Promise.resolve([]);
  });
  const readBefore = vi.fn(() => {
    return Promise.resolve([]);
  });
  const messageExists = vi.fn(() => {
    return Promise.resolve(false);
  });
  const upsertMessages = vi.fn(() => {
    return Promise.resolve();
  });

  return {
    readLatest,
    readBefore,
    messageExists,
    upsertMessages,
    reset() {
      readLatest.mockReset();
      readLatest.mockResolvedValue([]);
      readBefore.mockReset();
      readBefore.mockResolvedValue([]);
      messageExists.mockReset();
      messageExists.mockResolvedValue(false);
      upsertMessages.mockReset();
      upsertMessages.mockResolvedValue(undefined);
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

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";
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

describe("zero chat thread IndexedDB fallback", () => {
  afterEach(() => {
    idbMessageStoreMock.reset();
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
});
