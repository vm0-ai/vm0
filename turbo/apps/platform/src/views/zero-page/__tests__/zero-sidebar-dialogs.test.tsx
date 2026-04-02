import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockAPIsWithSubagents({
  pinnedAgentIds = ["pinned-agent-id"],
}: { pinnedAgentIds?: string[] } = {}) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "pinned-agent-id",
          displayName: "Pinned Agent",
          description: "A pinned sub-agent",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
        {
          id: "unpinned-agent-id",
          displayName: "Unpinned Agent",
          description: "An unpinned sub-agent",
          sound: null,
          avatarUrl: null,
          headVersionId: "version_3",
          updatedAt: "2024-01-03T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "new-thread-from-dialog",
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: "session-new",
        unsavedRuns: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.post("*/api/zero/chat-threads", () => {
      return HttpResponse.json(
        {
          id: "new-thread-from-dialog",
          title: null,
          createdAt: "2026-03-10T00:00:00Z",
        },
        { status: 201 },
      );
    }),
    http.get("*/api/zero/user-preferences", () => {
      return HttpResponse.json({
        timezone: null,
        pinnedAgentIds,
        sendMode: "enter" as const,
      });
    }),
    http.post("*/api/zero/user-preferences", async ({ request }) => {
      const body = (await request.json()) as { pinnedAgentIds?: string[] };
      return HttpResponse.json({
        timezone: null,
        pinnedAgentIds: body.pinnedAgentIds ?? pinnedAgentIds,
        sendMode: "enter" as const,
      });
    }),
  );
}

async function openChatListDialog(user: ReturnType<typeof userEvent.setup>) {
  const openButton = await waitFor(() => {
    return screen.getByLabelText("Open a conversation");
  });
  await user.click(openButton);
  await waitFor(() => {
    expect(screen.getByText("Talk to")).toBeInTheDocument();
  });
}

describe("chatListDialog", () => {
  it("should navigate to chat when clicking a pinned agent", async () => {
    const user = userEvent.setup();
    mockAPIsWithSubagents();
    await setupPage({ context, path: "/agents" });

    await openChatListDialog(user);

    // Wait for the "Pinned" section label to appear, then find the chat button
    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Pinned")).toBeInTheDocument();
    });

    // The pinned agent's onChat button contains the agent name text
    const dialog = screen.getByRole("dialog");
    const pinnedAgentText = within(dialog).getByText("Pinned Agent");
    const pinnedAgentButton = pinnedAgentText.closest("button")!;

    await user.click(pinnedAgentButton);

    // Should navigate to /chat/:threadId
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-from-dialog");
    });
  });

  it("should navigate to chat when clicking an unpinned agent", async () => {
    const user = userEvent.setup();
    mockAPIsWithSubagents();
    await setupPage({ context, path: "/agents" });

    await openChatListDialog(user);

    // Find the unpinned agent button and click it
    const unpinnedAgentButton = await waitFor(() => {
      return screen.getByRole("button", { name: /Unpinned Agent/ });
    });

    await user.click(unpinnedAgentButton);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-from-dialog");
    });
  });

  it("should render unpinned agent avatars without reduced opacity", async () => {
    const user = userEvent.setup();
    mockAPIsWithSubagents();
    await setupPage({ context, path: "/agents" });

    await openChatListDialog(user);

    // Wait for the "Others" section to render with the unpinned agent
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(within(dialog).getByText("Others")).toBeInTheDocument();
    });

    // Find the unpinned agent's avatar image within the dialog
    const unpinnedAvatar = within(dialog).getByAltText("Unpinned Agent");
    expect(unpinnedAvatar.className).not.toContain("opacity-60");
  });

  it("should navigate to chat when clicking the lead agent", async () => {
    const user = userEvent.setup();
    mockAPIsWithSubagents();
    await setupPage({ context, path: "/agents" });

    await openChatListDialog(user);

    // The lead agent section should have a clickable button
    const leadButton = await waitFor(() => {
      return screen
        .getByText("Your lead assistant, always here for you")
        .closest("button")!;
    });

    await user.click(leadButton);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-from-dialog");
    });
  });
});
