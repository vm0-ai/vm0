import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockTwoAgents() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: false,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: "agent-foo-id",
        defaultAgentMetadata: { displayName: "foo" },
        defaultAgentSkills: [],
      });
    }),
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "agent-foo-id",
          displayName: "foo",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "agent-bar-id",
          displayName: "bar",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("talk to activity agent retention", () => {
  it("should retain non-default agent in sidebar after navigating from /talk/:agentId to /activity", async () => {
    mockTwoAgents();

    // Navigate to non-default agent (bar)
    await setupPage({ context, path: "/talk/agent-bar-id" });

    // Wait for sidebar to show "bar" as the active chat agent
    await waitFor(
      () => {
        expect(screen.getByLabelText("New chat with bar")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // Click the "Activity logs" nav tab in the sidebar
    const activityNavLink = screen.getByRole("link", {
      name: "Activity logs",
    });
    fireEvent.click(activityNavLink);

    // Wait for navigation to /activity to complete
    await waitFor(
      () => {
        expect(pathname()).toBe("/activity");
      },
      { timeout: 5000 },
    );

    // After navigating to /activity, the sidebar should still show "chat with bar"
    // (the last visited agent), not "chat with foo" (the default agent)
    await waitFor(
      () => {
        expect(screen.getByLabelText("New chat with bar")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  }, 15_000);
});
