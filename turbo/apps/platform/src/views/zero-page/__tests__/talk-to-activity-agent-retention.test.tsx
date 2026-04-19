import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { FeatureSwitchKey, zeroAgentsByIdContract } from "@vm0/core";
import { mockApi } from "../../../mocks/msw-contract.ts";

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
        "agent-foo-id": {
          agentId: "agent-foo-id",
          ownerId: "test-user",
          displayName: "foo",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        },
        "agent-bar-id": {
          agentId: "agent-bar-id",
          ownerId: "test-user",
          displayName: "bar",
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
  );
}

describe("talk to activity agent retention", () => {
  it("should retain non-default agent in sidebar after navigating from /agents/:id/chat to /activity", async () => {
    const user = userEvent.setup();
    mockTwoAgents();

    // Navigate to non-default agent (bar)
    detachedSetupPage({
      context,
      path: "/agents/agent-bar-id/chat",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: true },
    });

    // Wait for sidebar to show "bar" as the active chat agent
    await waitFor(() => {
      expect(screen.getByLabelText("New chat with bar")).toBeInTheDocument();
    });

    // Click the "Activity logs" nav tab in the sidebar
    const activityNavLink = screen.getByText("Activity logs");
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
