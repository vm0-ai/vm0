import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

type ThreadFixture = {
  id: string;
  title: string | null;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  isRead: boolean;
  running: boolean;
};

function makeThread(
  id: string,
  title: string | null,
  createdAt: string,
  pinnedAt: string | null = null,
): ThreadFixture {
  return {
    id,
    title,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt,
    updatedAt: createdAt,
    pinnedAt,
    isRead: true,
    running: false,
  };
}

function sortThreadsLikeServer(list: ThreadFixture[]): ThreadFixture[] {
  return [...list].sort((a, b) => {
    const aPinned = a.pinnedAt !== null;
    const bPinned = b.pinnedAt !== null;
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function setupMocks(initial: ThreadFixture[]) {
  let threads = sortThreadsLikeServer(initial);
  let lastPinned: string | null = null;
  let lastUnpinned: string | null = null;
  let lastDeleted: string | null = null;

  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(
        200,
        splitChatThreadListResponse(sortThreadsLikeServer(threads)),
      );
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      const thread = threads.find((t) => {
        return t.id === params.id;
      });
      return respond(200, {
        id: params.id,
        title: thread?.title ?? null,
        agentId: AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(chatThreadByIdContract.delete, ({ params, respond }) => {
      lastDeleted = params.id;
      threads = threads.filter((t) => {
        return t.id !== params.id;
      });
      return respond(204);
    }),
    mockApi(chatThreadPinContract.pin, ({ params, respond }) => {
      lastPinned = params.id;
      threads = threads.map((t) => {
        return t.id === params.id
          ? { ...t, pinnedAt: "2026-03-11T00:00:00Z" }
          : t;
      });
      return respond(204);
    }),
    mockApi(chatThreadUnpinContract.unpin, ({ params, respond }) => {
      lastUnpinned = params.id;
      threads = threads.map((t) => {
        return t.id === params.id ? { ...t, pinnedAt: null } : t;
      });
      return respond(204);
    }),
  );

  return {
    getLastPinned: () => {
      return lastPinned;
    },
    getLastUnpinned: () => {
      return lastUnpinned;
    },
    getLastDeleted: () => {
      return lastDeleted;
    },
  };
}

describe("sidebar chat thread pin", () => {
  it("none pinned: each row shows kebab trigger with Pin + Delete items", async () => {
    setupMocks([
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
      makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-1",
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const triggers = screen.getAllByTestId("chat-thread-menu-trigger");
    expect(triggers).toHaveLength(2);
    expect(
      triggers.every((el) => {
        return el.dataset.pinned === "false";
      }),
    ).toBeTruthy();

    click(triggers[0]);

    const menu = await waitFor(() => {
      return screen.getByRole("menu");
    });
    expect(within(menu).getByText("Pin chat")).toBeInTheDocument();
    expect(within(menu).getByText("Delete chat")).toBeInTheDocument();
    expect(within(menu).queryByText("Unpin chat")).not.toBeInTheDocument();
  });

  it("pinned thread present: trigger shows pin icon and menu reads Unpin", async () => {
    setupMocks([
      makeThread(
        "thread-pinned",
        "Pinned chat",
        "2026-03-09T00:00:00Z",
        "2026-03-09T12:00:00Z",
      ),
      makeThread("thread-other", "Other chat", "2026-03-10T00:00:00Z"),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-other",
    });

    await waitFor(() => {
      expect(screen.getByText("Pinned chat")).toBeInTheDocument();
    });

    const triggers = screen.getAllByTestId("chat-thread-menu-trigger");
    const pinnedTrigger = triggers.find((el) => {
      return el.dataset.pinned === "true";
    });
    expect(pinnedTrigger).toBeDefined();

    click(pinnedTrigger!);

    const menu = await waitFor(() => {
      return screen.getByRole("menu");
    });
    expect(within(menu).getByText("Unpin chat")).toBeInTheDocument();
    expect(within(menu).queryByText("Pin chat")).not.toBeInTheDocument();
  });

  it("click Pin: sends POST /pin, refetches, row floats to top", async () => {
    const { getLastPinned } = setupMocks([
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
      makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-1",
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const triggers = screen.getAllByTestId("chat-thread-menu-trigger");
    // Trigger index 1 belongs to "Second chat".
    click(triggers[1]);

    const menu = await waitFor(() => {
      return screen.getByRole("menu");
    });
    click(within(menu).getByText("Pin chat"));

    await waitFor(() => {
      expect(getLastPinned()).toBe("thread-2");
    });

    await waitFor(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("a[data-chat-thread-id]"),
      );
      expect(rows[0]?.dataset.chatThreadId).toBe("thread-2");
      expect(rows[1]?.dataset.chatThreadId).toBe("thread-1");
    });
  });

  it("click Delete in menu: opens confirm dialog and deletes", async () => {
    const { getLastDeleted } = setupMocks([
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
      makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-1",
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const triggers = screen.getAllByTestId("chat-thread-menu-trigger");
    click(triggers[0]);

    const menu = await waitFor(() => {
      return screen.getByRole("menu");
    });
    click(within(menu).getByText("Delete chat"));

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    click(within(dialog).getByText("Delete"));

    await waitFor(() => {
      expect(getLastDeleted()).toBe("thread-1");
    });
  });
});
