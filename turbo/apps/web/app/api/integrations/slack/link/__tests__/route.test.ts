import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET, POST } from "../route";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
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

    it("returns isLinked=false when user is not linked", async () => {
      await context.setupUser();
      const { installation } = await givenSlackWorkspaceInstalled();

      const request = new Request(
        `http://localhost:3000/api/integrations/slack/link?slackUserId=U-new&workspaceId=${installation.slackWorkspaceId}`,
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isLinked).toBe(false);
    });

    it("returns isLinked=true with workspace name when user is linked", async () => {
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
