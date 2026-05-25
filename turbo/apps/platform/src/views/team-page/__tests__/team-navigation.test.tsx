import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroComposesMainContract } from "@vm0/api-contracts/contracts/zero-composes";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function createMockTeamWithSubagents() {
  return [
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
      id: "agent-2",
      displayName: "Research Agent",
      description: "Finds and summarizes information",
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ];
}

function mockAPIs() {
  setMockTeam(createMockTeamWithSubagents());
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        pinned: [],
        threads: [],
        hasMore: false,
        nextCursor: null,
        totalCount: 0,
      });
    }),
    mockApi(zeroComposesMainContract.getByName, ({ respond }) => {
      return respond(200, {
        id: "agent-2",
        name: "research-agent",
        headVersionId: "version_2",
        content: {
          version: "1",
          agents: {
            "research-agent": {
              description: "Finds and summarizes information",
              framework: "claude-code",
            },
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
      });
    }),
    mockApi(zeroAgentsByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        agentId: params.id,
        ownerId: "test-owner-id",
        displayName: "Research Agent",
        description: "Finds and summarizes information",
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
        modelProviderId: null,
        selectedModel: null,
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

describe("team page navigation", () => {
  it("should render team list at /team", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });
  });

  it("should render agent detail at /team/:name", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/agent-2" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
    });
  });

  it("should navigate from detail back to team list via breadcrumb", async () => {
    mockAPIs();

    // Start on the detail page
    detachedSetupPage({ context, path: "/agents/agent-2" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
    });

    // Click the breadcrumb link to navigate back to /team
    const teamLinks = screen.getAllByText("Agents");
    // Find the breadcrumb link (inside a nav with breadcrumb-like structure)
    const breadcrumbLink = teamLinks
      .map((el) => {
        return el.closest("a");
      })
      .find((a) => {
        return a?.getAttribute("href") === "/agents";
      });
    expect(breadcrumbLink).toBeTruthy();
    await act(() => {
      breadcrumbLink!.click();
    });

    // Wait for team list to render
    await waitFor(() => {
      expect(
        screen.getByText(/agents/i, { selector: "h1" }),
      ).toBeInTheDocument();
    });
  });
});
