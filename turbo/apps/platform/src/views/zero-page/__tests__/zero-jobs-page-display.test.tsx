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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

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

describe("zero jobs page - sub-agent grid", () => {
  it("renders sub-agent cards in the grid", async () => {
    setMockTeam([
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

    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByText("Beta")).toBeInTheDocument();
    });
  });

  it("renders agent display name and falls back to id when displayName is null", async () => {
    setMockTeam([
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

    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Research Assistant")).toBeInTheDocument();
      // Agent with null displayName falls back to id
      expect(screen.getByText("agent-no-name")).toBeInTheDocument();
    });
  });

  it("renders avatar images for agents with custom avatarUrl", async () => {
    setMockTeam([
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

    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByAltText("Avatar Agent")).toBeInTheDocument();
    });
  });
});
