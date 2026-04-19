import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { navigate$ } from "../../../signals/route.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadsContract, zeroAgentsByIdContract } from "@vm0/core";

const context = testContext();

/**
 * Agent-aware mock: returns threads filtered by the `agentId` query param,
 * matching real API behaviour.
 */
function mockTwoAgents() {
  const allThreads = [
    {
      id: "thread-alpha-1",
      title: "Alpha thread",
      agentId: "agent-alpha",
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
    },
    {
      id: "thread-beta-1",
      title: "Beta thread",
      agentId: "agent-beta",
      createdAt: "2026-03-09T00:00:00Z",
      updatedAt: "2026-03-09T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
    },
  ];

  setMockTeam([
    {
      id: "mock-compose-id",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-alpha",
      displayName: "Alpha Bot",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-beta",
      displayName: "Beta Bot",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_3",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ params, respond }) => {
      const agents: Record<
        string,
        {
          agentId: string;
          displayName: string;
          ownerId: string;
          description: null;
          sound: null;
          avatarUrl: null;
          permissionPolicies: null;
          customSkills: string[];
        }
      > = {
        "mock-compose-id": {
          agentId: "mock-compose-id",
          ownerId: "test-user",
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        },
        "agent-alpha": {
          agentId: "agent-alpha",
          ownerId: "test-user",
          displayName: "Alpha Bot",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        },
        "agent-beta": {
          agentId: "agent-beta",
          ownerId: "test-user",
          displayName: "Beta Bot",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
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
    mockApi(chatThreadsContract.list, ({ query, respond }) => {
      const agentId = query.agentId;
      const filtered = agentId
        ? allThreads.filter((t) => {
            return t.agentId === agentId;
          })
        : [];
      return respond(200, { threads: filtered });
    }),
  );
}

describe("sidebar agent scoping (#7239)", () => {
  it("should show Alpha chats on /talk/agent-alpha and Beta chats on /talk/agent-beta", async () => {
    mockTwoAgents();
    detachedSetupPage({ context, path: "/agents/agent-alpha/chat" });

    // Alpha thread should be visible
    await waitFor(() => {
      expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    });
    expect(screen.getByText("Chats with Alpha Bot")).toBeInTheDocument();
    // Beta thread must NOT appear
    expect(screen.queryByText("Beta thread")).not.toBeInTheDocument();

    // Navigate to Beta agent within the same session
    await context.store.set(
      navigate$,
      "/agents/agent-beta/chat",
      {},
      context.signal,
    );

    // Beta thread should now be visible
    await waitFor(() => {
      expect(screen.getByText("Beta thread")).toBeInTheDocument();
    });
    expect(screen.getByText("Chats with Beta Bot")).toBeInTheDocument();
    // Alpha thread must NOT appear
    expect(screen.queryByText("Alpha thread")).not.toBeInTheDocument();
  });

  it("should switch back to first agent after visiting second agent", async () => {
    mockTwoAgents();
    detachedSetupPage({ context, path: "/agents/agent-alpha/chat" });

    await waitFor(() => {
      expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    });

    // Navigate Alpha → Beta → Alpha
    await context.store.set(
      navigate$,
      "/agents/agent-beta/chat",
      {},
      context.signal,
    );
    await waitFor(() => {
      expect(screen.getByText("Beta thread")).toBeInTheDocument();
    });

    await context.store.set(
      navigate$,
      "/agents/agent-alpha/chat",
      {},
      context.signal,
    );

    await waitFor(() => {
      expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    });
    expect(screen.queryByText("Beta thread")).not.toBeInTheDocument();
  });

  it("should retain agent scope when navigating to a non-chat page and back", async () => {
    mockTwoAgents();
    detachedSetupPage({ context, path: "/agents/agent-beta/chat" });

    // Verify Beta threads are shown
    await waitFor(() => {
      expect(screen.getByText("Beta thread")).toBeInTheDocument();
    });
    expect(screen.queryByText("Alpha thread")).not.toBeInTheDocument();

    // Navigate to a non-chat page (activity logs)
    await context.store.set(navigate$, "/activities", {}, context.signal);

    // Sidebar should still show Beta chats (persists across non-chat pages)
    await waitFor(() => {
      expect(screen.getByText("Chats with Beta Bot")).toBeInTheDocument();
    });
    expect(screen.getByText("Beta thread")).toBeInTheDocument();
    expect(screen.queryByText("Alpha thread")).not.toBeInTheDocument();
  });

  it("should update sidebar to show agent chats when navigating to /team/:agentId profile page", async () => {
    mockTwoAgents();

    // Start with Alpha's chat view — sidebar remembers Alpha
    detachedSetupPage({ context, path: "/agents/agent-alpha/chat" });
    await waitFor(() => {
      expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    });

    // Navigate to Beta's profile page (/team/:agentId)
    // Bug: setupTeamDetailPage$ does not call setSidebarChatAgent$,
    // so the sidebar still shows Alpha's chats instead of Beta's.
    await context.store.set(
      navigate$,
      "/agents/agent-beta",
      {},
      context.signal,
    );

    // Sidebar should switch to Beta's chats
    await waitFor(() => {
      expect(screen.getByText("Chats with Beta Bot")).toBeInTheDocument();
    });
    expect(screen.getByText("Beta thread")).toBeInTheDocument();
    expect(screen.queryByText("Alpha thread")).not.toBeInTheDocument();
  });
});
