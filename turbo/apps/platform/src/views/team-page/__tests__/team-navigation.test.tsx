import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function createMockTeamWithSubagents() {
  return [
    {
      id: "mock-compose-id",
      name: "zero",
      displayName: null,
      description: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
      isOwner: true,
    },
    {
      id: "agent-2",
      name: "research-agent",
      displayName: "Research Agent",
      description: "Finds and summarizes information",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
      isOwner: false,
    },
  ];
}

function mockTeamAndDetailAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json({ composes: createMockTeamWithSubagents() });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/composes/:id", ({ params }) => {
      if (params.id === "list") return;
      return HttpResponse.json({
        id: params.id,
        name: "research-agent",
        headVersionId: "version_2",
        content: {
          version: "1",
          agents: {
            "research-agent": {
              framework: "claude-code",
              description: "Finds and summarizes information",
            },
          },
        },
        createdAt: "2024-01-02T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
      });
    }),
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({
        composes: createMockTeamWithSubagents().map(
          ({ id, name, displayName, headVersionId, updatedAt }) => ({
            id,
            name,
            displayName,
            headVersionId,
            updatedAt,
          }),
        ),
      });
    }),
    http.get("*/api/agent/composes/:id/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [] });
    }),
    http.get("*/api/agent/required-env", () => {
      return HttpResponse.json({ agents: [] });
    }),
  );
}

describe("team page navigation", () => {
  it("should navigate from team list to detail and back to team list", async () => {
    mockTeamAndDetailAPIs();

    // Start on team list page
    await setupPage({ context, path: "/team" });

    // Wait for sub-agents to render
    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    // Click a sub-agent card to navigate to detail
    fireEvent.click(screen.getByText("Research Agent"));

    // Wait for detail page to render (breadcrumb with "Zero's team" link)
    await waitFor(() => {
      // The breadcrumb shows "Zero's team" as a link back
      const breadcrumbLinks = screen
        .getAllByText("Zero's team")
        .filter((el) => el.closest("nav[class*='breadcrumb'], nav.shrink-0"));
      expect(breadcrumbLinks.length).toBeGreaterThan(0);
    });

    // Click sidebar "Zero's team" link to go back to team list
    const sidebarTeamLinks = screen.getAllByText("Zero's team");
    // Find the one in a sidebar element
    const sidebarLink = sidebarTeamLinks.find(
      (el) => el.closest("aside") !== null,
    );
    expect(sidebarLink).toBeDefined();
    fireEvent.click(sidebarLink!);

    // Assert: team list renders again with sub-agent cards visible
    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
      expect(
        screen.getByText("Finds and summarizes information"),
      ).toBeInTheDocument();
    });
  });
});
