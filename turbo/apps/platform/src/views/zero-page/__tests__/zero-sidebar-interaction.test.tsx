/**
 * Interaction tests for ZeroSidebar component.
 *
 * Tests cover account dropdown, search, new chat creation, thread deletion,
 * agent card toggle, manage pinned dialog, sidebar collapse, and agent action menu.
 *
 * Follows platform testing principles:
 * - Entry point: setupPage({ context, path })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { splitChatThreadListResponse } from "./chat-test-helpers.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  sidebarExpanded$,
  setSidebarExpanded$,
} from "../../../signals/zero-page/zero-nav.ts";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  fireClerkListeners,
  mockedClerk,
  mockUser,
} from "../../../__tests__/mock-auth.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const context = testContext();
const mockApi = createMockApi(context);

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const PINNED_AGENT_ID = "agent-pinned-id";

function makeThread(
  id: string,
  title: string,
  createdAt: string,
): {
  id: string;
  title: string;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  running: boolean;
} {
  return {
    id,
    title,
    agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
    createdAt,
    updatedAt: createdAt,
    isRead: false,
    running: false,
  };
}

function makeDefaultAgent() {
  return {
    id: DEFAULT_AGENT_ID,
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function makePinnedAgent() {
  return {
    id: PINNED_AGENT_ID,
    displayName: "Research Agent",
    description: "A pinned sub-agent",
    sound: null,
    avatarUrl: null,
    headVersionId: "version_2",
    updatedAt: "2024-01-02T00:00:00Z",
  };
}

function mockBaseAPIs(options?: {
  threads?: {
    id: string;
    title: string;
    agent: { id: string; avatarUrl: string | null };
    createdAt: string;
    updatedAt: string;
    isRead: boolean;
    running: boolean;
  }[];
  agents?: {
    id: string;
    displayName: string | null;
    description: string | null;
    sound: null;
    avatarUrl: null;
    headVersionId: string;
    updatedAt: string;
  }[];
}) {
  const agents = options?.agents ?? [makeDefaultAgent()];
  const threads = options?.threads ?? [];

  setMockTeam(agents);
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse(threads));
    }),
    mockApi(zeroAgentsByIdContract.get, ({ params, respond }) => {
      const agents: Record<
        string,
        {
          agentId: string;
          displayName: string | null;
          ownerId: string;
          description: string | null;
          sound: null;
          avatarUrl: null;
          customSkills: string[];
        }
      > = {
        [DEFAULT_AGENT_ID]: {
          agentId: DEFAULT_AGENT_ID,
          ownerId: "test-user",
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          customSkills: [],
        },
        [PINNED_AGENT_ID]: {
          agentId: PINNED_AGENT_ID,
          ownerId: "test-user",
          displayName: "Research Agent",
          description: "A pinned sub-agent",
          sound: null,
          avatarUrl: null,
          customSkills: [],
        },
      };
      const agent = agents[params.id];
      if (!agent) {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, agent);
    }),
  );
}

beforeEach(() => {
  setMockUserPreferences({ pinnedAgentIds: [] });
});

describe("zero sidebar - account dropdown opens (SIDEBAR-D-013)", () => {
  it("shows a dropdown menu with sign-out option when account trigger is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    const accountTrigger = screen.getByText("Test User");
    click(accountTrigger);

    await waitFor(() => {
      expect(screen.getByText("Sign out")).toBeInTheDocument();
    });
  });

  it("shows credits in the account dropdown for org admins", async () => {
    setMockBillingStatus({ credits: 12_345 });
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Default Org")).toBeInTheDocument();
    });

    click(screen.getByText("Test User"));

    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(
        queryAllByRoleFast("menuitem", menu).find((element) => {
          return element.textContent?.includes("12,345 credits");
        }),
      ).toBeDefined();
    });
  });

  it("hides credit balance in the account dropdown for org members", async () => {
    setMockOrg({ role: "member" });
    setMockBillingStatus({ credits: 12_345 });
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Default Org")).toBeInTheDocument();
    });

    click(screen.getByText("Test User"));

    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(within(menu).getByText("Settings")).toBeInTheDocument();
    });
    expect(within(menu).queryByText("Credit balance")).not.toBeInTheDocument();
    expect(within(menu).queryByText(/12,345/)).not.toBeInTheDocument();
  });

  it("shows Lab entry in account dropdown when FeatureSwitchKey.Lab is on", async () => {
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.Lab]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    expect(screen.getByText("Lab")).toBeInTheDocument();
  });

  it("hides Lab entry in account dropdown when FeatureSwitchKey.Lab is off", async () => {
    mockBaseAPIs();
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.Lab]: false },
    });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    expect(screen.queryByText("Lab")).not.toBeInTheDocument();
  });

  it("hides Lab entry in account dropdown during onboarding even when FeatureSwitchKey.Lab is on", async () => {
    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        return respond(200, {
          needsOnboarding: true,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: false,
          defaultAgentId: null,
          defaultAgentMetadata: null,
        });
      }),
      mockApi(onboardingSetupContract.setup, ({ respond }) => {
        return respond(200, {
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
    );
    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.Lab]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(screen.getByText("Sign out")).toBeInTheDocument();
    });
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Lab")).not.toBeInTheDocument();
  });
});

describe("zero sidebar - account profile refresh", () => {
  it("updates the account trigger after Clerk profile changes", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    mockUser(
      {
        id: "test-user-123",
        fullName: "Renamed User",
        email: "renamed@example.com",
      },
      { token: "test-token" },
    );
    fireClerkListeners();

    await waitFor(() => {
      expect(screen.getByText("Renamed User")).toBeInTheDocument();
      expect(screen.getByText("renamed@example.com")).toBeInTheDocument();
    });
    expect(screen.queryByText("Test User")).not.toBeInTheDocument();
  });
});

describe("zero sidebar - sign-out option works (SIDEBAR-D-014)", () => {
  it("calls clerk signOut and closes the dropdown when sign-out is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    const accountTrigger = screen.getByText("Test User");
    click(accountTrigger);

    const signOutItem = await waitFor(() => {
      return screen.getByText("Sign out");
    });
    click(signOutItem);

    expect(mockedClerk.signOut).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
    });
  });
});

describe("zero sidebar - new chat button creates session (SIDEBAR-D-017)", () => {
  it("creates a new chat session and navigates to it", async () => {
    mockBaseAPIs();
    let createdThreadId: string | null = null;

    server.use(
      mockApi(chatThreadsContract.create, ({ body, respond }) => {
        createdThreadId = body.clientThreadId ?? "new-thread-id";
        return respond(201, {
          id: createdThreadId,
          title: null,
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: DEFAULT_AGENT_ID,
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    // Start on the default agent chat page so currentChatAgentId$ resolves before we click
    detachedSetupPage({
      context,
      path: `/agents/${DEFAULT_AGENT_ID}/chat`,
    });

    // Wait for the sidebar to finish loading (empty state confirms threads loaded
    // and the default agent id has resolved)
    const newChatButton = await waitFor(() => {
      expect(
        screen.getByText("Start a conversation and it'll show up here"),
      ).toBeInTheDocument();
      return screen.getByLabelText("New chat with Zero");
    });

    click(newChatButton);

    await waitFor(() => {
      if (createdThreadId === null) {
        throw new Error("expected a thread to be created");
      }
      expect(pathname()).toBe(`/chats/${createdThreadId}`);
    });
  });
});

describe("zero sidebar - delete thread button shows confirmation (SIDEBAR-D-018)", () => {
  it("shows a confirmation dialog when the delete button is clicked", async () => {
    mockBaseAPIs({
      threads: [makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z")],
    });
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    // Open the kebab menu, then click Delete.
    const menuTriggers = screen.getAllByLabelText("Open chat menu");
    click(menuTriggers[0]);
    const deleteItem = await waitFor(() => {
      const item = queryAllByRoleFast("menuitem").find((el) => {
        return /Delete chat/i.test(el.textContent ?? "");
      });
      if (!item) {
        throw new Error("Delete chat menu item not visible yet");
      }
      return item;
    });
    click(deleteItem);

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Delete chat?")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - confirm delete removes thread (SIDEBAR-D-019)", () => {
  it("removes the thread from the list after confirming deletion", async () => {
    let threads = [
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
      makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    ];

    setMockTeam([makeDefaultAgent()]);
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
          agentId: DEFAULT_AGENT_ID,
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

    detachedSetupPage({ context, path: "/chats/thread-2" });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    // Open the kebab menu, then click Delete.
    const menuTriggers = screen.getAllByLabelText("Open chat menu");
    click(menuTriggers[0]);
    const deleteItem = await waitFor(() => {
      const item = queryAllByRoleFast("menuitem").find((el) => {
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

    const confirmButton = queryAllByRoleFast("button", dialog).find((el) => {
      return el.textContent?.trim() === "Delete";
    });
    expect(confirmButton).toBeDefined();
    click(confirmButton!);

    await waitFor(() => {
      expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    });

    const sidebar = screen.getByLabelText("Sidebar");
    expect(within(sidebar).getByText("Second chat")).toBeInTheDocument();
  });
});

describe("zero sidebar - agent card toggles chat list (SIDEBAR-D-020)", () => {
  it("hides pinned agent cards when the Pinned header is clicked", async () => {
    mockBaseAPIs({ agents: [makeDefaultAgent(), makePinnedAgent()] });
    setMockUserPreferences({ pinnedAgentIds: [PINNED_AGENT_ID] });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Pinned")).toBeInTheDocument();
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    const pinnedHeader = screen.getByTestId("pinned-section-header");
    click(pinnedHeader);

    await waitFor(() => {
      expect(screen.queryByText("Research Agent")).not.toBeInTheDocument();
    });
  });
});

describe("zero sidebar - sidebar collapse button hides sidebar (SIDEBAR-D-022)", () => {
  it("collapses the sidebar and shows expand button when collapse is clicked", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    const collapseBtn = screen.getByLabelText("Collapse sidebar");
    click(collapseBtn);

    await waitFor(() => {
      expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
    });
  });
});

describe("zero sidebar - collapse button closes mobile overlay (SIDEBAR-M-023)", () => {
  it("sets sidebarExpanded to false when collapse button is clicked while sidebar is open as mobile overlay", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: "Sidebar" }),
      ).toBeInTheDocument();
    });

    // Simulate mobile sidebar expanded state (as if "Open menu" was tapped)
    context.store.set(setSidebarExpanded$, true);

    expect(context.store.get(sidebarExpanded$)).toBeTruthy();

    const collapseBtn = screen.getByLabelText("Collapse sidebar");
    click(collapseBtn);

    expect(context.store.get(sidebarExpanded$)).toBeFalsy();
  });
});

describe("zero sidebar - settings click closes mobile overlay (SIDEBAR-M-030)", () => {
  it("sets sidebarExpanded to false when Settings is clicked from account dropdown while sidebar is open as mobile overlay", async () => {
    mockBaseAPIs();
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeInTheDocument();
    });

    // Simulate mobile sidebar expanded state (as if "Open menu" was tapped)
    context.store.set(setSidebarExpanded$, true);
    expect(context.store.get(sidebarExpanded$)).toBeTruthy();

    // Open account dropdown
    click(screen.getByText("Test User"));

    // Click Settings
    const settingsItem = await waitFor(() => {
      return screen.getByText("Settings");
    });
    click(settingsItem);

    // The sidebar overlay should close when navigating to settings
    expect(context.store.get(sidebarExpanded$)).toBeFalsy();
  });
});

describe("zero sidebar - agent action menu opens (SIDEBAR-D-066)", () => {
  it("reveals the remove action button on a pinned agent card", async () => {
    const user = userEvent.setup();
    mockBaseAPIs({ agents: [makeDefaultAgent(), makePinnedAgent()] });
    setMockUserPreferences({ pinnedAgentIds: [PINNED_AGENT_ID] });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    // The "Remove from list" button is revealed via CSS on hover
    const removeButton = screen.getByLabelText("Remove from list");
    await user.hover(removeButton);
    expect(removeButton).toBeVisible();
  });
});
