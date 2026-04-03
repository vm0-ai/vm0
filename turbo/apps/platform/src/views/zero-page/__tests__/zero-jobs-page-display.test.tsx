/**
 * Display and conditional tests for the /agents page (ZeroJobsPage component).
 *
 * Tests display rendering and conditional UI states via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/agents" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function defaultAgent() {
  return {
    id: "c0000000-0000-4000-a000-000000000001",
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

describe("zero jobs page - lead agent display", () => {
  it("shows lead agent with core agent description (AGENT-D-001)", async () => {
    await setupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Your core agent")).toBeInTheDocument();
    });
  });
});

describe("zero jobs page - sub-agent grid", () => {
  it("renders sub-agent cards in the grid (AGENT-D-002)", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          defaultAgent(),
          {
            id: "agent-alpha",
            displayName: "Alpha",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "v2",
            updatedAt: "2024-01-02T00:00:00Z",
          },
          {
            id: "agent-beta",
            displayName: "Beta",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "v3",
            updatedAt: "2024-01-03T00:00:00Z",
          },
        ]);
      }),
    );

    await setupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByText("Beta")).toBeInTheDocument();
    });
  });

  it("shows loading skeletons while agents are loading (AGENT-D-003)", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return new Promise<never>(() => {
          // Never resolves — keeps component in loading state
        });
      }),
    );

    await setupPage({ context, path: "/agents" });

    const skeletons = screen.getAllByTestId("agent-skeleton");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows only lead card when no sub-agents exist (AGENT-D-004)", async () => {
    // Default handler already returns only the default agent (no sub-agents)
    await setupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Your core agent")).toBeInTheDocument();
    });
    // No sub-agent description rendered
    expect(screen.queryByText("Sub-agent")).not.toBeInTheDocument();
  });

  it("shows error message when agents API fails (AGENT-D-005)", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Internal server error",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 500 },
        );
      }),
    );

    await setupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });

  it("renders agent display name on cards (AGENT-D-006)", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          defaultAgent(),
          {
            id: "agent-named",
            displayName: "Research Assistant",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "v2",
            updatedAt: "2024-01-02T00:00:00Z",
          },
          {
            id: "agent-no-name",
            displayName: null,
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "v3",
            updatedAt: "2024-01-03T00:00:00Z",
          },
        ]);
      }),
    );

    await setupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Research Assistant")).toBeInTheDocument();
      // Agent with null displayName falls back to id
      expect(screen.getByText("agent-no-name")).toBeInTheDocument();
    });
  });

  it("renders avatar images for agents with custom avatarUrl (AGENT-D-007)", async () => {
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([
          defaultAgent(),
          {
            id: "agent-with-avatar",
            displayName: "Avatar Agent",
            description: null,
            sound: null,
            avatarUrl: "https://example.com/avatar.png",
            headVersionId: "v2",
            updatedAt: "2024-01-02T00:00:00Z",
          },
        ]);
      }),
    );

    await setupPage({ context, path: "/agents" });

    await waitFor(() => {
      const img = screen.getByAltText("Avatar Agent");
      expect(img).toBeInTheDocument();
      expect(img.getAttribute("src")).toBe("https://example.com/avatar.png");
    });
  });
});
