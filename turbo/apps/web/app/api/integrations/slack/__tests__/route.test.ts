import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET, DELETE, PATCH } from "../route";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import {
  mockClerk,
  MOCK_USER_EMAIL,
} from "../../../../../src/__tests__/clerk-mock";
import {
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../../src/__tests__/slack/api-helpers";
import {
  createTestCompose,
  findTestAgentPermissions,
  findTestComposeWithScope,
  insertTestAgentPermission,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

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

    it("grants permissions on new agent and revokes old agent permissions", async () => {
      const { userLink, installation } = await givenLinkedSlackUser({
        isAdmin: true,
      });

      // Create new agent WITHOUT updating the installation's defaultComposeId
      mockClerk({ userId: userLink.vm0UserId });
      const { composeId: newComposeId } = await createTestCompose("new-agent");

      // Verify initial state: user has permission on old (default) agent
      const oldPermissions = await findTestAgentPermissions(
        installation.defaultComposeId,
        MOCK_USER_EMAIL,
      );
      expect(oldPermissions).toHaveLength(1);

      // Switch agent via PATCH
      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "new-agent" }),
        },
      );
      const response = await PATCH(request);
      expect(response.status).toBe(200);

      // Verify: permission on new agent exists
      const newPermissions = await findTestAgentPermissions(
        newComposeId,
        MOCK_USER_EMAIL,
      );
      expect(newPermissions).toHaveLength(1);

      // Verify: permission on old agent is revoked
      const revokedPermissions = await findTestAgentPermissions(
        installation.defaultComposeId,
        MOCK_USER_EMAIL,
      );
      expect(revokedPermissions).toHaveLength(0);
    });

    it("skips revocation when old agent is SLACK_DEFAULT_AGENT", async () => {
      const { userLink, installation } = await givenLinkedSlackUser({
        isAdmin: true,
      });

      mockClerk({ userId: userLink.vm0UserId });

      // Find the scope slug and name used for the default agent
      const defaultCompose = await findTestComposeWithScope(
        installation.defaultComposeId,
      );

      // Set SLACK_DEFAULT_AGENT to match the current default agent
      vi.stubEnv(
        "SLACK_DEFAULT_AGENT",
        `${defaultCompose!.scopeSlug}/${defaultCompose!.composeName}`,
      );
      reloadEnv();

      // Create new agent WITHOUT updating installation's defaultComposeId
      const { composeId: newComposeId } =
        await createTestCompose("replacement-agent");

      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "replacement-agent" }),
        },
      );
      const response = await PATCH(request);
      expect(response.status).toBe(200);

      // Verify: permission on new agent exists
      const newPermissions = await findTestAgentPermissions(
        newComposeId,
        MOCK_USER_EMAIL,
      );
      expect(newPermissions).toHaveLength(1);

      // Verify: permission on old (default) agent is NOT revoked
      const oldPermissions = await findTestAgentPermissions(
        installation.defaultComposeId,
        MOCK_USER_EMAIL,
      );
      expect(oldPermissions).toHaveLength(1);
    });

    it("handles duplicate permissions gracefully", async () => {
      const { userLink } = await givenLinkedSlackUser({ isAdmin: true });

      // Create new agent WITHOUT updating installation's defaultComposeId
      mockClerk({ userId: userLink.vm0UserId });
      const { composeId: newComposeId } =
        await createTestCompose("shared-agent");

      // Pre-grant permission (simulates CLI share)
      await insertTestAgentPermission(
        newComposeId,
        MOCK_USER_EMAIL,
        "cli-user",
      );

      // Switch to agent that already has permission — should not error
      const request = new Request(
        "http://localhost:3000/api/integrations/slack",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "shared-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Permission should still exist (not duplicated)
      const permissions = await findTestAgentPermissions(
        newComposeId,
        MOCK_USER_EMAIL,
      );
      expect(permissions).toHaveLength(1);
    });
  });
});
