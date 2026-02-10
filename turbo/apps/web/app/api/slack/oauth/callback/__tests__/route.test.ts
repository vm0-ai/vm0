import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
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

    it("should redirect to success page on successful OAuth exchange", async () => {
      const mockClient = vi.mocked(new WebClient(), true);
      mockClient.oauth.v2.access.mockResolvedValueOnce({
        ok: true,
        access_token: "xoxb-test-token",
        bot_user_id: "U123456",
        team: { id: "T123456", name: "Test Workspace" },
      } as never);

      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback?code=valid-code",
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      const locationHeader = response.headers.get("Location");
      expect(locationHeader).toContain("/slack/success");
      expect(locationHeader).toContain("workspace=Test%20Workspace");
      expect(locationHeader).toContain("workspace_id=T123456");
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
  });
});
