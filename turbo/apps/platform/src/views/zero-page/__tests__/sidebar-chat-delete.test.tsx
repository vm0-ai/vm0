import { describe, expect, it } from "vitest";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { createNewChatThreadOptimistically$ } from "../../../signals/chat-page/optimistic-chat-thread-page.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function makeThread(
  id: string,
  title: string | null,
  createdAt: string,
): {
  id: string;
  title: string | null;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  running: boolean;
} {
  return {
    id,
    title,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt,
    updatedAt: createdAt,
    isRead: false,
    running: false,
  };
}

function mockAPIs() {
  let threads = [
    makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
    makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    makeThread("thread-3", "Third chat", "2026-03-08T00:00:00Z"),
  ];

  let lastDeletedId: string | null = null;
  let lastCreatedId: string | null = null;

  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse(threads));
    }),
    mockApi(chatThreadsContract.create, ({ body, respond }) => {
      const now = "2026-03-11T00:00:00Z";
      const id = body.clientThreadId ?? "created-thread";
      lastCreatedId = id;
      threads = [
        {
          id,
          title: body.title ?? null,
          agent: { id: body.agentId, avatarUrl: null },
          createdAt: now,
          updatedAt: now,
          isRead: true,
          running: false,
        },
        ...threads,
      ];
      return respond(201, {
        id,
        title: body.title ?? null,
        createdAt: now,
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      const thread = threads.find((t) => {
        return t.id === params.id;
      });
      return respond(200, {
        id: params.id,
        title: thread?.title ?? null,
        agentId: AGENT_ID,
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(chatThreadByIdContract.delete, ({ params, respond }) => {
      const id = params.id;
      lastDeletedId = id;
      threads = threads.filter((t) => {
        return t.id !== id;
      });
      return respond(204);
    }),
  );

  return {
    getLastDeletedId: () => {
      return lastDeletedId;
    },
    getThreads: () => {
      return threads;
    },
    getLastCreatedId: () => {
      return lastCreatedId;
    },
  };
}

async function deleteThread(nthButton: number) {
  // The per-thread delete is reached through the kebab menu trigger;
  // open it first then click the "Delete chat" item.
  const menuTriggers = await waitFor(() => {
    const btns = screen.getAllByLabelText("Open chat menu");
    expect(btns.length).toBeGreaterThanOrEqual(nthButton);
    return btns;
  });

  click(menuTriggers[nthButton - 1]);

  const deleteItem = await waitFor(() => {
    const item = screen.getAllByRole("menuitem").find((el) => {
      return /Delete chat/i.test(el.textContent ?? "");
    });
    if (!item) {
      throw new Error("Delete chat menu item not visible yet");
    }
    return item;
  });
  click(deleteItem);

  const dialog = await waitFor(() => {
    return screen.getByRole("dialog");
  });

  const confirmBtn = within(dialog).getByText("Delete");
  click(confirmBtn);
}

describe("sidebar chat delete", () => {
  it("should send the correct thread ID when deleting the first thread", async () => {
    const { getLastDeletedId } = mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    await deleteThread(1);

    await waitFor(() => {
      expect(getLastDeletedId()).toBe("thread-1");
    });
  });

  it("should send the correct thread ID when deleting a middle thread", async () => {
    const { getLastDeletedId } = mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(screen.getByText("Second chat")).toBeInTheDocument();
    });

    await deleteThread(2);

    await waitFor(() => {
      expect(getLastDeletedId()).toBe("thread-2");
    });
  });

  it("should remove the deleted thread from the sidebar list", async () => {
    mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-2" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    await deleteThread(1);

    await waitFor(() => {
      expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    });

    const sidebar = screen.getByLabelText("Sidebar");
    expect(within(sidebar).getByText("Second chat")).toBeInTheDocument();
    expect(within(sidebar).getByText("Third chat")).toBeInTheDocument();
  });

  it("should not resurrect a deleted optimistic-created thread", async () => {
    const { getLastCreatedId } = mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-2" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    await context.store.set(
      createNewChatThreadOptimistically$,
      AGENT_ID,
      "main",
      context.signal,
    );
    const createdId = getLastCreatedId();
    expect(createdId).not.toBeNull();
    if (!createdId) {
      throw new Error("Expected optimistic-created thread id");
    }

    await waitFor(() => {
      expect(
        document.querySelector(`a[href="/chats/${createdId}"]`),
      ).toBeInTheDocument();
    });

    await deleteThread(1);

    await waitFor(() => {
      expect(
        document.querySelector(`a[href="/chats/${createdId}"]`),
      ).not.toBeInTheDocument();
    });
  });

  it("should navigate to the next thread after deleting the current one", async () => {
    mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    await deleteThread(1);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-2");
    });
  });

  it("should navigate to the previous thread when deleting the last one in the list", async () => {
    mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-3" });

    await waitFor(() => {
      expect(screen.getByText("Third chat")).toBeInTheDocument();
    });

    await deleteThread(3);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-2");
    });
  });

  it("should navigate away from the chat page when deleting the only remaining thread", async () => {
    let threads = [
      makeThread("thread-only", "Only chat", "2026-03-10T00:00:00Z"),
    ];

    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, splitChatThreadListResponse(threads));
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        const thread = threads.find((t) => {
          return t.id === params.id;
        });
        return respond(200, {
          id: params.id,
          title: thread?.title ?? null,
          agentId: AGENT_ID,
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      mockApi(chatThreadByIdContract.delete, ({ params, respond }) => {
        threads = threads.filter((t) => {
          return t.id !== params.id;
        });
        return respond(204);
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-only" });

    await waitFor(() => {
      expect(screen.getByText("Only chat")).toBeInTheDocument();
    });

    await deleteThread(1);

    await waitFor(() => {
      expect(pathname()).not.toBe("/chats/thread-only");
    });
  });
});
