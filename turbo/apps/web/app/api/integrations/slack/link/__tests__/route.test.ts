import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET, POST } from "../route";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import {
  mockClerk,
  MOCK_USER_EMAIL,
} from "../../../../../../src/__tests__/clerk-mock";
import {
  createTestCompose,
  findTestAgentPermissions,
  findTestSlackInstallation,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  givenSlackWorkspaceInstalled,
  givenLinkedSlackUser,
} from "../../../../../../src/__tests__/slack/api-helpers";

const context = testContext();

describe("/api/integrations/slack/link", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/integrations/slack/link", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link?slackUserId=U123&workspaceId=T123",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when required params are missing", async () => {
      await context.setupUser();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns isLinked=false with agent fields when user is not linked", async () => {
      await context.setupUser();
      const { installation } = await givenSlackWorkspaceInstalled();

      const request = new Request(
        `http://localhost:3000/api/integrations/slack/link?slackUserId=U-new&workspaceId=${installation.slackWorkspaceId}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isLinked).toBe(false);
      expect(data.isAdmin).toBe(false);
      expect(data.defaultAgent).toEqual(
        expect.objectContaining({ id: installation.defaultComposeId }),
      );
      expect(data.agents).toHaveLength(1);
    });

    it("returns isLinked=true with workspace name and agent fields when user is linked", async () => {
      const { userLink, installation } = await givenLinkedSlackUser();
      mockClerk({ userId: userLink.vm0UserId });

      const request = new Request(
        `http://localhost:3000/api/integrations/slack/link?slackUserId=${userLink.slackUserId}&workspaceId=${installation.slackWorkspaceId}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isLinked).toBe(true);
      expect(data.workspaceName).toBe("Test Workspace");
      expect(data.isAdmin).toBe(false);
      expect(data.defaultAgent).toEqual(
        expect.objectContaining({ id: installation.defaultComposeId }),
      );
    });

    it("returns isAdmin=true with user agents for admin slack user", async () => {
      const { userLink, installation } = await givenLinkedSlackUser({
        isAdmin: true,
      });
      mockClerk({ userId: userLink.vm0UserId });

      // Create an additional agent for the admin user
      await createTestCompose("extra-agent");

      const request = new Request(
        `http://localhost:3000/api/integrations/slack/link?slackUserId=${userLink.slackUserId}&workspaceId=${installation.slackWorkspaceId}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(true);
      expect(data.defaultAgent).toEqual(
        expect.objectContaining({ id: installation.defaultComposeId }),
      );
      // Admin sees default agent + their own agents (deduplicated)
      expect(data.agents.length).toBeGreaterThanOrEqual(2);
      expect(data.agents[0].id).toBe(installation.defaultComposeId);
    });
  });

  describe("POST /api/integrations/slack/link", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slackUserId: "U123",
            workspaceId: "T123",
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when required fields are missing", async () => {
      await context.setupUser();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 404 when workspace is not installed", async () => {
      await context.setupUser();

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slackUserId: "U123",
            workspaceId: "T-nonexistent",
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("links a new Slack user successfully", async () => {
      const user = await context.setupUser();
      const { installation } = await givenSlackWorkspaceInstalled();
      mockClerk({ userId: user.userId });

      // Mock WebClient for refreshAppHome and postEphemeral calls
      vi.mocked(new WebClient(), true);

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slackUserId: "U-new-user",
            workspaceId: installation.slackWorkspaceId,
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("links with custom agentId when provided", async () => {
      const user = await context.setupUser();
      const { installation } = await givenSlackWorkspaceInstalled();
      mockClerk({ userId: user.userId });

      // Create an additional agent for the user (scope already exists from setupUser)
      const { composeId: customAgentId } =
        await createTestCompose("custom-agent");

      vi.mocked(new WebClient(), true);

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slackUserId: "U-new-user",
            workspaceId: installation.slackWorkspaceId,
            agentId: customAgentId,
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("returns success with alreadyLinked for already-linked user", async () => {
      const { userLink, installation } = await givenLinkedSlackUser();
      mockClerk({ userId: userLink.vm0UserId });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slackUserId: userLink.slackUserId,
            workspaceId: installation.slackWorkspaceId,
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.alreadyLinked).toBe(true);
    });

    it("syncs permissions when admin selects a different agent", async () => {
      const { userLink, installation } = await givenLinkedSlackUser({
        isAdmin: true,
      });
      mockClerk({ userId: userLink.vm0UserId });

      // Create a new agent for the admin to switch to
      const { composeId: newAgentId } =
        await createTestCompose("new-slack-agent");

      vi.mocked(new WebClient(), true);

      // Verify: user has permission on old (default) agent
      const oldPermissions = await findTestAgentPermissions(
        installation.defaultComposeId,
        MOCK_USER_EMAIL,
      );
      expect(oldPermissions).toHaveLength(1);

      // Admin links with a different agentId → triggers permission sync
      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slackUserId: userLink.slackUserId,
            workspaceId: installation.slackWorkspaceId,
            agentId: newAgentId,
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify: installation's defaultComposeId was updated
      const updatedInstallation = await findTestSlackInstallation(
        installation.slackWorkspaceId,
      );
      expect(updatedInstallation!.defaultComposeId).toBe(newAgentId);

      // Verify: permission on new agent exists
      const newPermissions = await findTestAgentPermissions(
        newAgentId,
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

    it("returns 409 when Slack user is linked to different VM0 account", async () => {
      const { userLink, installation } = await givenLinkedSlackUser();

      // Switch to a different VM0 user
      const otherUser = await context.setupUser();
      mockClerk({ userId: otherUser.userId });

      const request = new Request(
        "http://localhost:3000/api/integrations/slack/link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slackUserId: userLink.slackUserId,
            workspaceId: installation.slackWorkspaceId,
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.error.code).toBe("CONFLICT");
    });
  });
});
