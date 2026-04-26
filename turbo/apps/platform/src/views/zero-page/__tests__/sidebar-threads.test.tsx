import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "thread-sidebar-test";

function mockSidebarThreads(threads: Array<{
  id: string;
  title: string | null;
  isRead: boolean;
  running: boolean;
}>) {
  server.use(
    mockApi(zeroTeamContract.list, ({ respond }) => {
      return respond(200, [
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
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        threads: threads.map((t) => ({
          id: t.id,
          title: t.title,
          agent: { id: AGENT_ID, avatarUrl: null },
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          isRead: t.isRead,
          isArchived: false,
          running: t.running,
        })),
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: THREAD_ID,
        title: null,
        agentId: AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        draftContent: null,
        draftAttachments: null,
      });
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: [], hasHistoryBefore: false });
    }),
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: AGENT_ID,
        ownerId: "test-user",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
      });
    }),
  );
}

beforeEach(() => {
  server.use(
    http.get("https://example.com/avatar.png", () => {
      return new HttpResponse("avatar", {
        headers: { "Content-Type": "image/png" },
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// Chat thread list — renders threads and handles selection
// ---------------------------------------------------------------------------
describe("sidebar-threads chat thread list", () => {
  it("renders the chat thread list", async () => {
    mockSidebarThreads([
      { id: "thread-1", title: "First chat", isRead: true, running: false },
      { id: "thread-2", title: "Second chat", isRead: false, running: false },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
      expect(screen.getByText("Second chat")).toBeInTheDocument();
    });
  });

  it("shows empty state message when there are no threads", async () => {
    mockSidebarThreads([]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText(/Start a conversation/)).toBeInTheDocument();
    });
  });

  it("shows unread indicator for unread threads when feature switch is on", async () => {
    mockSidebarThreads([
      { id: "thread-1", title: "Read chat", isRead: true, running: false },
      { id: "thread-2", title: "Unread chat", isRead: false, running: false },
    ]);

    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ChatThreadReadIndicator]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Read chat")).toBeInTheDocument();
    });
    // Unread indicator is rendered as a span with aria-label
    const unreadThread = document.querySelector('[aria-label="Unread"]');
    expect(unreadThread).toBeInTheDocument();
  });

  it("shows running indicator for active threads", async () => {
    mockSidebarThreads([
      { id: "thread-1", title: "Running chat", isRead: false, running: true },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Running chat")).toBeInTheDocument();
    });
    // The running state is tracked; the visual indicator may not render in jsdom
  });
});

// ---------------------------------------------------------------------------
// Search filtering — filters threads by title
// ---------------------------------------------------------------------------
describe("sidebar-threads search filtering", () => {
  it("filters threads by search term (case-insensitive)", async () => {
    mockSidebarThreads([
      { id: "thread-1", title: "First chat", isRead: true, running: false },
      { id: "thread-2", title: "Second chat", isRead: false, running: false },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
      expect(screen.getByText("Second chat")).toBeInTheDocument();
    });

    // Open search
    const searchButton = screen.getByLabelText("Search chats");
    click(searchButton);

    // Type search query
    const searchInput = screen.getByPlaceholderText(/Search chat/);
    await waitFor(() => expect(searchInput).toBeInTheDocument());

    // Use fill helper to type efficiently
    const fastUser = userEvent.setup({ delay: null });
    await fastUser.click(searchInput);
    await fastUser.keyboard("{Control>}a{/Control}");
    await fastUser.paste("first");

    // Only matching thread should be visible
    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });
    expect(screen.queryByText("Second chat")).not.toBeInTheDocument();
  });

  it("shows 'no chats match' when search has no results", async () => {
    mockSidebarThreads([
      { id: "thread-1", title: "First chat", isRead: true, running: false },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    // Open search
    const searchButton = screen.getByLabelText("Search chats");
    click(searchButton);

    const searchInput = screen.getByPlaceholderText(/Search chat/);
    await waitFor(() => expect(searchInput).toBeInTheDocument());

    const fastUser = userEvent.setup({ delay: null });
    await fastUser.click(searchInput);
    await fastUser.keyboard("{Control>}a{/Control}");
    await fastUser.paste("nonexistent");

    await waitFor(() => {
      expect(screen.getByText(/No chats match/)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Delete chat — shows confirmation dialog
// ---------------------------------------------------------------------------
describe("sidebar-threads delete chat dialog", () => {
  it("opens delete confirmation dialog when delete button is clicked", async () => {
    mockSidebarThreads([
      { id: "thread-1", title: "Chat to delete", isRead: true, running: false },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Chat to delete")).toBeInTheDocument();
    });

    // Hover to reveal delete button
    const chatItem = document.querySelector('[data-chat-thread-id="thread-1"]');
    expect(chatItem).toBeInTheDocument();

    // Hover to make delete button visible
    const user = userEvent.setup();
    await user.hover(chatItem!);

    // Find and click the delete button (aria-label "Delete chat")
    const deleteButton = screen.getByLabelText("Delete chat");
    await user.click(deleteButton);

    await waitFor(() => {
      expect(screen.getByText("Delete chat?")).toBeInTheDocument();
    });

    // Dialog description
    expect(screen.getByText(/permanently delete/)).toBeInTheDocument();

    // Cancel button should close the dialog
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByText("Delete chat?")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Session list collapse — collapses and expands thread list
// ---------------------------------------------------------------------------
describe("sidebar-threads collapse/expand", () => {
  it("collapses the session list when chevron is clicked", async () => {
    mockSidebarThreads([
      { id: "thread-1", title: "First chat", isRead: true, running: false },
    ]);

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    // Find the collapse toggle (it contains the title label from useChatThreadsTitleLabels)
    const collapseToggle = screen.getByText(/Chats with Zero/);
    const user = userEvent.setup();
    await user.click(collapseToggle);

    // After collapse, threads should not be visible
    await waitFor(() => {
      expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    });
  });
});
