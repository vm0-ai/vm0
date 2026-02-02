import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";

// Mock external dependencies
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

// Mock slack client
vi.mock("../../../../../../src/lib/slack/client", () => ({
  exchangeOAuthCode: vi.fn(),
}));

import { exchangeOAuthCode } from "../../../../../../src/lib/slack/client";

const context = testContext();

describe("/api/slack/oauth/callback", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.clearAllMocks();
    // Reset to default test values
    vi.stubEnv("SLACK_CLIENT_ID", "test-slack-client-id");
    vi.stubEnv("SLACK_CLIENT_SECRET", "test-slack-client-secret");
    vi.stubEnv("SLACK_REDIRECT_BASE_URL", "");
    reloadEnv();
  });

  describe("GET /api/slack/oauth/callback", () => {
    it("should return 503 when Slack credentials are not configured", async () => {
      vi.stubEnv("SLACK_CLIENT_ID", "");
      vi.stubEnv("SLACK_CLIENT_SECRET", "");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback?code=test-code",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.error).toBe("Slack integration is not configured");
    });

    it("should redirect to failed page when error parameter is present", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback?error=access_denied",
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      const locationHeader = response.headers.get("Location");
      expect(locationHeader).toBe(
        "http://localhost:3000/slack/failed?error=access_denied",
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
      vi.mocked(exchangeOAuthCode).mockResolvedValue({
        accessToken: "xoxb-test-token",
        botUserId: "U123456",
        teamId: "T123456",
        teamName: "Test Workspace",
      });

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
      vi.mocked(exchangeOAuthCode).mockRejectedValue(
        new Error("invalid_code: Code has expired"),
      );

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

    it("should call exchangeOAuthCode with correct parameters", async () => {
      vi.stubEnv("SLACK_REDIRECT_BASE_URL", "https://tunnel.example.com");
      reloadEnv();

      vi.mocked(exchangeOAuthCode).mockResolvedValue({
        accessToken: "xoxb-test-token",
        botUserId: "U123456",
        teamId: "T123456",
        teamName: "Test Workspace",
      });

      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/callback?code=test-code",
      );
      await GET(request);

      expect(exchangeOAuthCode).toHaveBeenCalledWith(
        "test-slack-client-id",
        "test-slack-client-secret",
        "test-code",
        "https://tunnel.example.com/api/slack/oauth/callback",
      );
    });
  });
});
