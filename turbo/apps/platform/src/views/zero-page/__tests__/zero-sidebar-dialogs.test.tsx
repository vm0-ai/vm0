import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  setManagePinnedDialogOpen$,
  setDraftPinnedIds$,
} from "../../../signals/zero-page/zero-sidebar-state.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAPIsWithSubagents({
  pinnedAgentIds = ["pinned-agent-id"],
}: { pinnedAgentIds?: string[] } = {}) {
  setMockTeam([
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
      avatarUrl: "preset:2",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
    {
      id: "unpinned-agent-id",
      displayName: "Unpinned Agent",
      description: "An unpinned sub-agent",
      sound: null,
      avatarUrl: "preset:3",
      headVersionId: "version_3",
      updatedAt: "2024-01-03T00:00:00Z",
    },
  ]);
  setMockUserPreferences({ pinnedAgentIds });
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads: [] });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: "new-thread-from-dialog",
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: "session-new",
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(chatThreadsContract.create, ({ respond }) => {
      return respond(201, {
        id: "new-thread-from-dialog",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

async function openChatListDialog() {
  const openButton = await waitFor(() => {
    return screen.getByLabelText("Open a conversation");
  });
  click(openButton);
  await waitFor(() => {
    expect(screen.getByText("Talk to")).toBeInTheDocument();
  });
}

function openManagePinnedDialog() {
  context.store.set(setDraftPinnedIds$, ["pinned-agent-id"]);
  context.store.set(setManagePinnedDialogOpen$, true);
}

describe("chatListDialog", () => {
  it("should navigate to chat when clicking a pinned agent", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });

    await openChatListDialog();

    // Wait for the "Pinned" section label to appear, then find the chat button
    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Pinned")).toBeInTheDocument();
    });

    // The pinned agent's onChat button contains the agent name text
    const dialog = screen.getByRole("dialog");
    const pinnedAgentText = within(dialog).getByText("Pinned Agent");
    const pinnedAgentButton = pinnedAgentText.closest("button")!;

    click(pinnedAgentButton);

    // Should navigate to /chat/:threadId
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-from-dialog");
    });
  });

  it("should navigate to chat when clicking an unpinned agent", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });

    await openChatListDialog();

    // Find the unpinned agent button and click it
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(within(dialog).getByText("Others")).toBeInTheDocument();
    });
    const unpinnedAgentText = within(dialog)
      .getAllByText(/Unpinned Agent/)
      .find((el) => {
        return el.closest("button") !== null;
      })!;
    const unpinnedAgentButton = unpinnedAgentText.closest("button")!;

    click(unpinnedAgentButton);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-from-dialog");
    });
  });

  it("should render unpinned agent avatars without reduced opacity", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });

    await openChatListDialog();

    // Wait for the "Others" section to render with the unpinned agent
    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(within(dialog).getByText("Others")).toBeInTheDocument();
    });

    // Find the unpinned agent's avatar within the dialog (SVG preview uses aria-label)
    const unpinnedAvatar = within(dialog).getByRole("img", {
      name: "Unpinned Agent",
    });
    expect(unpinnedAvatar.className).not.toContain("opacity-60");
  });

  it("should navigate to chat when clicking the lead agent", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });

    await openChatListDialog();

    // The lead agent section should have a clickable button
    const leadButton = await waitFor(() => {
      return screen
        .getByText("Your lead assistant, always here for you")
        .closest("button")!;
    });

    click(leadButton);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-from-dialog");
    });
  });
});

describe("managePinnedAgentsDialog - pinned agents list renders (SIDEBAR-D-026)", () => {
  it("displays the pinned agent name in the dialog", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    openManagePinnedDialog();

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      expect(within(dialog).getByText("Pinned Agent")).toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - available agents list renders (SIDEBAR-D-027)", () => {
  it("shows unpinned agents in the Available agents section", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    // Only pin one agent; the other appears in available
    context.store.set(setDraftPinnedIds$, ["pinned-agent-id"]);
    context.store.set(setManagePinnedDialogOpen$, true);

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      expect(within(dialog).getByText("Available agents")).toBeInTheDocument();
      expect(within(dialog).getByText("Unpinned Agent")).toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - lead agent displays distinctly (SIDEBAR-D-028)", () => {
  it("shows the Lead badge for the zero agent", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    openManagePinnedDialog();

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      expect(within(dialog).getByText("Lead")).toBeInTheDocument();
    });
  });
});

describe("chatListDialog - agent search results filter (SIDEBAR-D-029)", () => {
  it("filters agent list to matching results when search term is typed", async () => {
    const user = userEvent.setup();
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    await openChatListDialog();

    const dialog = screen.getByRole("dialog");
    const searchInput = within(dialog).getByPlaceholderText("Search agents...");
    // Search for "Unpinned" which uniquely matches "Unpinned Agent" but not "Pinned Agent"
    await user.type(searchInput, "Unpinned");

    await waitFor(() => {
      expect(within(dialog).getByText("Unpinned Agent")).toBeInTheDocument();
      expect(
        within(dialog).queryByText("Pinned Agent"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - dialog title and description render (SIDEBAR-D-030)", () => {
  it("shows the dialog title and description text", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    openManagePinnedDialog();

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      expect(
        within(dialog).getByText("Manage pinned agents"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("Reorder or add agents to your sidebar."),
      ).toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - pin status visual feedback displays (SIDEBAR-D-032)", () => {
  it("shows distinct unpin and pin buttons for pinned and available agents", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    openManagePinnedDialog();

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      // Pinned agent has unpin button
      expect(
        within(dialog).getByLabelText("Unpin Pinned Agent"),
      ).toBeInTheDocument();
      // Available agent has pin button
      expect(
        within(dialog).getByLabelText("Pin to sidebar"),
      ).toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - drag-and-drop reorders pinned agents (SIDEBAR-D-033)", () => {
  it("reflects the new order in the pinned list after reorder", async () => {
    mockAPIsWithSubagents({
      pinnedAgentIds: ["pinned-agent-id", "unpinned-agent-id"],
    });
    detachedSetupPage({ context, path: "/agents" });

    // Seed draft with both agents pinned
    context.store.set(setDraftPinnedIds$, [
      "pinned-agent-id",
      "unpinned-agent-id",
    ]);
    context.store.set(setManagePinnedDialogOpen$, true);

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      expect(within(dialog).getByText("Pinned Agent")).toBeInTheDocument();
      expect(within(dialog).getByText("Unpinned Agent")).toBeInTheDocument();
    });

    // Simulate reorder via signal (as drag end would do)
    context.store.set(setDraftPinnedIds$, [
      "unpinned-agent-id",
      "pinned-agent-id",
    ]);

    await waitFor(() => {
      const pinnedItems = within(dialog).getAllByLabelText(/Unpin /);
      // After reorder, Unpinned Agent should appear before Pinned Agent
      expect(pinnedItems[0]).toHaveAttribute(
        "aria-label",
        "Unpin Unpinned Agent",
      );
      expect(pinnedItems[1]).toHaveAttribute(
        "aria-label",
        "Unpin Pinned Agent",
      );
    });
  });
});

describe("managePinnedAgentsDialog - unpin button removes agent from pinned (SIDEBAR-D-034)", () => {
  it("moves the agent from pinned to available when unpin is clicked", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    openManagePinnedDialog();

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Unpin Pinned Agent"),
      ).toBeInTheDocument();
    });

    click(within(dialog).getByLabelText("Unpin Pinned Agent"));

    await waitFor(() => {
      // Should no longer be in pinned section
      expect(
        within(dialog).queryByLabelText("Unpin Pinned Agent"),
      ).not.toBeInTheDocument();
      // Should appear in available agents
      expect(within(dialog).getByText("Available agents")).toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - pin button adds agent to pinned (SIDEBAR-D-035)", () => {
  it("moves the agent from available to pinned when pin is clicked", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    // Start with no agents pinned
    context.store.set(setDraftPinnedIds$, []);
    context.store.set(setManagePinnedDialogOpen$, true);

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      expect(within(dialog).getByText("Available agents")).toBeInTheDocument();
    });

    // Click pin button for an agent in available list
    const pinButton = within(dialog).getAllByLabelText("Pin to sidebar")[0]!;
    click(pinButton);

    await waitFor(() => {
      // The agent should now appear in pinned section with unpin button
      const unpinBtn = within(dialog)
        .getAllByRole("button")
        .find((el) => {
          return /Unpin /.test(el.getAttribute("aria-label") ?? "");
        });
      expect(unpinBtn).toBeDefined();
    });
  });
});

describe("chatListDialog - agent list item opens chat on click (SIDEBAR-D-036)", () => {
  it("opens a chat session when a pinned agent is clicked in the dialog", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    await openChatListDialog();

    await waitFor(() => {
      expect(
        within(screen.getByRole("dialog")).getByText("Pinned"),
      ).toBeInTheDocument();
    });

    const pinnedAgentBtn = within(screen.getByRole("dialog"))
      .getByText("Pinned Agent")
      .closest("button")!;
    click(pinnedAgentBtn);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-from-dialog");
    });
  });
});

describe("chatListDialog - search input accepts text (SIDEBAR-D-037)", () => {
  it("accepts text typed into the search input", async () => {
    const user = userEvent.setup();
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    await openChatListDialog();

    const dialog = screen.getByRole("dialog");
    const searchInput = within(dialog).getByPlaceholderText("Search agents...");
    await user.type(searchInput, "hello");

    expect(searchInput).toHaveValue("hello");
  });
});

describe("chatListDialog - clear search button resets dialog search (SIDEBAR-D-038)", () => {
  it("clears the search field and restores the full agent list", async () => {
    const user = userEvent.setup();
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    await openChatListDialog();

    const dialog = screen.getByRole("dialog");
    const searchInput = within(dialog).getByPlaceholderText("Search agents...");
    // Search for "Unpinned" which uniquely matches "Unpinned Agent" but not "Pinned Agent"
    await user.type(searchInput, "Unpinned");

    await waitFor(() => {
      expect(
        within(dialog).queryByText("Pinned Agent"),
      ).not.toBeInTheDocument();
    });

    const clearButton = within(dialog).getByLabelText("Clear search");
    click(clearButton);

    await waitFor(() => {
      expect(within(dialog).getByText("Pinned Agent")).toBeInTheDocument();
      expect(within(dialog).getByText("Unpinned Agent")).toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - save button persists changes (SIDEBAR-D-039)", () => {
  it("saves the new pinned order and closes the dialog when Save is clicked", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    openManagePinnedDialog();

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    const saveButton = within(dialog).getByText("Save");
    click(saveButton);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - cancel button discards changes (SIDEBAR-D-040)", () => {
  it("closes the dialog without saving when Cancel is clicked", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    openManagePinnedDialog();

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    const cancelButton = within(dialog).getByText("Cancel");
    click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

describe("managePinnedAgentsDialog - reorder handle is present (SIDEBAR-D-041)", () => {
  it("shows a drag handle button for each pinned agent", async () => {
    mockAPIsWithSubagents();
    detachedSetupPage({ context, path: "/agents" });
    openManagePinnedDialog();

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Reorder Pinned Agent"),
      ).toBeInTheDocument();
    });
  });
});

describe("chatListDialog - pin buttons disabled during save (SIDEBAR-D-042)", () => {
  it("disables pin and reorder buttons while save is in progress and re-enables after completion", async () => {
    const postDeferred = createDeferredPromise<void>(context.signal);

    mockAPIsWithSubagents({ pinnedAgentIds: ["pinned-agent-id"] });
    server.use(
      mockApi(zeroUserPreferencesContract.update, async ({ respond }) => {
        await postDeferred.promise;
        return respond(200, {
          timezone: null,
          pinnedAgentIds: ["pinned-agent-id", "unpinned-agent-id"],
          sendMode: "enter",
          captureNetworkBodiesRemaining: 0,
        });
      }),
    );

    detachedSetupPage({ context, path: "/agents" });
    await openChatListDialog();

    const dialog = screen.getByRole("dialog");

    // Wait for both pinned and unpinned agents to load
    await waitFor(() => {
      expect(within(dialog).getByText("Pinned")).toBeInTheDocument();
      expect(within(dialog).getByText("Others")).toBeInTheDocument();
    });

    // Click the pin button for the unpinned agent to trigger a save
    const pinButton = within(dialog).getByLabelText("Pin to sidebar");
    click(pinButton);

    // While save is pending, existing pin/unpin/reorder buttons should be disabled
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Unpin Pinned Agent"),
      ).toBeDisabled();
      expect(
        within(dialog).getByLabelText("Reorder Pinned Agent"),
      ).toBeDisabled();
    });

    // Resolve the pending request
    postDeferred.resolve();

    // After save completes, buttons should be re-enabled
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Unpin Pinned Agent"),
      ).not.toBeDisabled();
      expect(
        within(dialog).getByLabelText("Reorder Pinned Agent"),
      ).not.toBeDisabled();
    });
  });
});
