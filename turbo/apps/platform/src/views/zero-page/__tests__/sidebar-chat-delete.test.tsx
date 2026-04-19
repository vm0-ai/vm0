import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function makeThread(
  id: string,
  title: string,
  createdAt: string,
): {
  id: string;
  title: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  isArchived: boolean;
  running: boolean;
} {
  return {
    id,
    title,
    agentId: AGENT_ID,
    createdAt,
    updatedAt: createdAt,
    isRead: false,
    isArchived: false,
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

  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: AGENT_ID,
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads });
    }),
    http.get("*/api/zero/chat-threads/:id", ({ params }) => {
      const thread = threads.find((t) => {
        return t.id === params.id;
      });
      return HttpResponse.json({
        id: params.id,
        title: thread?.title ?? null,
        agentId: AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.delete("*/api/zero/chat-threads/:id", ({ params }) => {
      const id = params.id as string;
      lastDeletedId = id;
      threads = threads.filter((t) => {
        return t.id !== id;
      });
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return {
    getLastDeletedId: () => {
      return lastDeletedId;
    },
    getThreads: () => {
      return threads;
    },
  };
}

async function deleteThread(
  user: ReturnType<typeof userEvent.setup>,
  nthButton: number,
) {
  const deleteButtons = await waitFor(() => {
    const btns = screen.getAllByLabelText("Delete chat");
    expect(btns.length).toBeGreaterThanOrEqual(nthButton);
    return btns;
  });

  await user.click(deleteButtons[nthButton - 1]);

  const dialog = await waitFor(() => {
    return screen.getByRole("dialog");
  });

  const confirmBtn = within(dialog).getByText("Delete");
  await user.click(confirmBtn);
}

describe("sidebar chat delete", () => {
  it("should send the correct thread ID when deleting the first thread", async () => {
    const user = userEvent.setup();
    const { getLastDeletedId } = mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    await deleteThread(user, 1);

    await waitFor(() => {
      expect(getLastDeletedId()).toBe("thread-1");
    });
  });

  it("should send the correct thread ID when deleting a middle thread", async () => {
    const user = userEvent.setup();
    const { getLastDeletedId } = mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(screen.getByText("Second chat")).toBeInTheDocument();
    });

    await deleteThread(user, 2);

    await waitFor(() => {
      expect(getLastDeletedId()).toBe("thread-2");
    });
  });

  it("should remove the deleted thread from the sidebar list", async () => {
    const user = userEvent.setup();
    mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-2" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    await deleteThread(user, 1);

    await waitFor(() => {
      expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    });

    expect(screen.getByText("Second chat")).toBeInTheDocument();
    expect(screen.getByText("Third chat")).toBeInTheDocument();
  });

  it("should navigate to the next thread after deleting the current one", async () => {
    const user = userEvent.setup();
    mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    await deleteThread(user, 1);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-2");
    });
  });

  it("should navigate to the previous thread when deleting the last one in the list", async () => {
    const user = userEvent.setup();
    mockAPIs();

    detachedSetupPage({ context, path: "/chats/thread-3" });

    await waitFor(() => {
      expect(screen.getByText("Third chat")).toBeInTheDocument();
    });

    await deleteThread(user, 3);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-2");
    });
  });

  it("should navigate away from the chat page when deleting the only remaining thread", async () => {
    const user = userEvent.setup();

    let threads = [
      makeThread("thread-only", "Only chat", "2026-03-10T00:00:00Z"),
    ];

    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          {
            id: AGENT_ID,
            displayName: null,
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ]);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads });
      }),
      http.get("*/api/zero/chat-threads/:id", ({ params }) => {
        const thread = threads.find((t) => {
          return t.id === params.id;
        });
        return HttpResponse.json({
          id: params.id,
          title: thread?.title ?? null,
          agentId: AGENT_ID,
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.delete("*/api/zero/chat-threads/:id", ({ params }) => {
        threads = threads.filter((t) => {
          return t.id !== params.id;
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-only" });

    await waitFor(() => {
      expect(screen.getByText("Only chat")).toBeInTheDocument();
    });

    await deleteThread(user, 1);

    await waitFor(() => {
      expect(pathname()).not.toBe("/chats/thread-only");
    });
  });
});
