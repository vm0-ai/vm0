import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

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
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json(createMockTeamWithSubagents());
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/composes", () => {
      return HttpResponse.json({
        id: "agent-2",
        content: {
          agents: {
            "research-agent": {
              description: "Finds and summarizes information",
              framework: null,
            },
          },
        },
      });
    }),
    http.get("*/api/zero/agents/:name", ({ params }) => {
      return HttpResponse.json({
        agentId: params.name as string,
        ownerId: "test-owner-id",
        displayName: "Research Agent",
        description: "Finds and summarizes information",
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json([]);
    }),
  );
}

describe("team page navigation", () => {
  it("should render team list at /team", async () => {
    mockAPIs();
    await setupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });
  });

  it("should render agent detail at /team/:name", async () => {
    mockAPIs();
    await setupPage({ context, path: "/agents/agent-2" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
    });
  });

  it("should navigate from detail back to team list via breadcrumb", async () => {
    mockAPIs();

    // Start on the detail page
    await setupPage({ context, path: "/agents/agent-2" });

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
