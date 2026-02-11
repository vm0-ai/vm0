import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET, DELETE, PATCH } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../../src/__tests__/slack/api-helpers";

const context = testContext();

describe("/api/integrations/slack", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/integrations/slack", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 with installUrl when user has no Slack link", async () => {
      const user = await context.setupUser();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
      expect(data.installUrl).toBeDefined();
      expect(data.installUrl).toContain("/api/slack/oauth/install");
      expect(data.installUrl).toContain(user.userId);
    });

    it("returns workspace info for linked user", async () => {
      const { userLink, installation } = await givenLinkedSlackUser();

      // Restore Clerk mock for the linked user
      mockClerk({ userId: userLink.vm0UserId });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.workspace.id).toBe(installation.slackWorkspaceId);
      expect(data.workspace.name).toBe(installation.slackWorkspaceName);
      expect(data.agent).toBeDefined();
      expect(data.agent.name).toBeDefined();
      expect(data.environment).toBeDefined();
      expect(data.environment.requiredSecrets).toBeDefined();
      expect(data.environment.requiredVars).toBeDefined();
      expect(data.environment.missingSecrets).toBeDefined();
      expect(data.environment.missingVars).toBeDefined();
    });

    it("returns isAdmin=false for non-admin users", async () => {
      const { userLink } = await givenLinkedSlackUser();

      // givenLinkedSlackUser creates a non-admin user by default
      mockClerk({ userId: userLink.vm0UserId });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      // The linked user is not the admin (admin was set during workspace install)
      expect(data.isAdmin).toBe(false);
    });
  });

  describe("DELETE /api/integrations/slack", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 when user has no Slack link", async () => {
      await context.setupUser();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("disconnects user and returns ok", async () => {
      const { userLink } = await givenLinkedSlackUser();

      mockClerk({ userId: userLink.vm0UserId });

      // Clear the WebClient mock to track calls from this point
      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.views.publish.mockClear();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify user is now disconnected by trying GET
      const getResponse = await GET(
        new Request("http://localhost:3000/api/integrations/slack"),
      );
      expect(getResponse.status).toBe(404);
    });
  });

  describe("PATCH /api/integrations/slack", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "test-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when agentName is missing", async () => {
      const { userLink } = await givenLinkedSlackUser();
      mockClerk({ userId: userLink.vm0UserId });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 403 when non-admin tries to update", async () => {
      const { userLink } = await givenLinkedSlackUser();
      mockClerk({ userId: userLink.vm0UserId });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "some-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("returns 404 when agent does not exist", async () => {
      const { userLink } = await givenLinkedSlackUser({ isAdmin: true });
      mockClerk({ userId: userLink.vm0UserId });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "nonexistent-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("updates the default agent successfully", async () => {
      const { userLink } = await givenLinkedSlackUser({ isAdmin: true });
      const { compose } = await givenUserHasAgent(userLink, {
        agentName: "new-agent",
      });

      mockClerk({ userId: userLink.vm0UserId });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: compose.name }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify the agent was updated by fetching the integration
      const getResponse = await GET(
        new Request("http://localhost:3000/api/integrations/slack"),
      );
      const getData = await getResponse.json();

      expect(getData.agent.name).toBe(compose.name);
    });
  });
});
