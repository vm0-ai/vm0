import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { FeatureSwitchKey } from "@vm0/core";

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
  it("should retain non-default agent in sidebar after navigating from /agents/:id/chat to /activity", async () => {
    const user = userEvent.setup();
    mockTwoAgents();

    // Navigate to non-default agent (bar)
    await setupPage({
      context,
      path: "/agents/agent-bar-id/chat",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: true },
    });

    // Wait for sidebar to show "bar" as the active chat agent
    await waitFor(() => {
      expect(screen.getByLabelText("New chat with bar")).toBeInTheDocument();
    });

    // Click the "Activity logs" nav tab in the sidebar
    const activityNavLink = screen.getByRole("link", {
      name: "Activity logs",
    });
    await user.click(activityNavLink);

    // Wait for navigation to /activity to complete
    await waitFor(() => {
      expect(pathname()).toBe("/activities");
    });

    // After navigating to /activity, the sidebar should still show "chat with bar"
    // (the last visited agent), not "chat with foo" (the default agent)
    await waitFor(() => {
      expect(screen.getByLabelText("New chat with bar")).toBeInTheDocument();
    });
  });
});
