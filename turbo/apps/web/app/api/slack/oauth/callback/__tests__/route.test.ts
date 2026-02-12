import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET } from "../route";
import {
  createTestRequest,
  createTestScope,
  createTestCompose,
  findTestSlackInstallation,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";

// Mock external dependencies required by testContext().setupMocks()

const context = testContext();

describe("/api/slack/oauth/callback", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET /api/slack/oauth/callback", () => {
    it("should redirect to failed page when error parameter is present", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback?error=access_denied",
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      const locationHeader = response.headers.get("Location");
      expect(locationHeader).toBe(
        "https://test.example.com/slack/failed?error=access_denied",
      );
    });

    it("should return 400 when code parameter is missing", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Missing authorization code");
    });

    it("should redirect to link page on successful OAuth exchange", async () => {
      // Create a compose to use as the default workspace agent
      const adminUserId = uniqueId("admin");
      mockClerk({ userId: adminUserId });
      await createTestScope(uniqueId("scope"));
      const { composeId } = await createTestCompose("test-agent");

      // Configure the WebClient singleton's oauth.v2.access to return expected values
      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.oauth.v2.access.mockResolvedValueOnce({
        ok: true,
        access_token: "xoxb-test-token",
        bot_user_id: "U123456",
        team: { id: "T123456", name: "Test Workspace" },
        authed_user: { id: "U-installer" },
      } as never);

      const state = JSON.stringify({ composeId });
      const request = createTestRequest(
        `http://localhost:3000/api/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      const locationHeader = response.headers.get("Location");
      expect(locationHeader).toContain("/slack/connect");
      expect(locationHeader).toContain("w=T123456");
      expect(locationHeader).toContain("u=U-installer");
    });

    it("should redirect to failed page when OAuth exchange fails", async () => {
      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.oauth.v2.access.mockResolvedValueOnce({
        ok: false,
        error: "invalid_code",
      } as never);

      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback?code=expired-code",
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      const locationHeader = response.headers.get("Location");
      expect(locationHeader).toContain("/slack/failed");
      expect(locationHeader).toContain("error=");
    });

    it("should use SLACK_REDIRECT_BASE_URL for redirects when configured", async () => {
      vi.stubEnv("SLACK_REDIRECT_BASE_URL", "https://tunnel.example.com");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback?error=access_denied",
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      const locationHeader = response.headers.get("Location");
      expect(locationHeader).toBe(
        "https://tunnel.example.com/slack/failed?error=access_denied",
      );
    });

    it("should send correct parameters to Slack OAuth API", async () => {
      vi.stubEnv("SLACK_REDIRECT_BASE_URL", "https://tunnel.example.com");
      reloadEnv();

      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.oauth.v2.access.mockResolvedValueOnce({
        ok: true,
        access_token: "xoxb-test-token",
        bot_user_id: "U123456",
        team: { id: "T123456", name: "Test Workspace" },
      } as never);

      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback?code=test-code",
      );
      await GET(request);

      // Verify the WebClient mock was called with correct parameters
      expect(mockClient.oauth.v2.access).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: "test-slack-client-id",
          client_secret: "test-slack-client-secret",
          code: "test-code",
          redirect_uri: "https://tunnel.example.com/api/slack/oauth/callback",
        }),
      );
    });

    it("should skip installation update entirely when workspace is already installed", async () => {
      const workspaceId = uniqueId("ws");

      // First install: admin is U-admin-original
      const adminUserId = uniqueId("admin");
      mockClerk({ userId: adminUserId });
      await createTestScope(uniqueId("scope"));
      const { composeId } = await createTestCompose("original-agent");

      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.oauth.v2.access.mockResolvedValueOnce({
        ok: true,
        access_token: "xoxb-original-token",
        bot_user_id: "B-original",
        team: { id: workspaceId, name: "Test Workspace" },
        authed_user: { id: "U-admin-original" },
      } as never);

      const firstState = JSON.stringify({ composeId });
      const firstRequest = createTestRequest(
        `http://localhost:3000/api/slack/oauth/callback?code=first-code&state=${encodeURIComponent(firstState)}`,
      );
      await GET(firstRequest);

      // Second OAuth: different user re-authorizes for same workspace
      mockClient.oauth.v2.access.mockResolvedValueOnce({
        ok: true,
        access_token: "xoxb-new-token",
        bot_user_id: "B-new",
        team: { id: workspaceId, name: "Renamed Workspace" },
        authed_user: { id: "U-non-admin" },
      } as never);

      const secondState = JSON.stringify({ composeId });
      const secondRequest = createTestRequest(
        `http://localhost:3000/api/slack/oauth/callback?code=second-code&state=${encodeURIComponent(secondState)}`,
      );
      await GET(secondRequest);

      // Verify the entire installation record is untouched
      const installation = await findTestSlackInstallation(workspaceId);

      expect(installation).toBeDefined();
      expect(installation!.adminSlackUserId).toBe("U-admin-original");
      expect(installation!.defaultComposeId).toBe(composeId);
      expect(installation!.slackWorkspaceName).toBe("Test Workspace");
      expect(installation!.botUserId).toBe("B-original");
    });
  });
});
