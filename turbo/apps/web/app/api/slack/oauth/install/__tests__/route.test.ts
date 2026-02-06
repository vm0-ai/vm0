import { describe, it, expect, vi } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../../src/env";

describe("/api/slack/oauth/install", () => {
  describe("GET /api/slack/oauth/install", () => {
    it("should redirect to Slack OAuth URL with correct parameters", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/install",
      );
      const response = await GET(request);

      expect(response.status).toBe(307);

      const locationHeader = response.headers.get("Location");
      expect(locationHeader).toBeDefined();

      const redirectUrl = new URL(locationHeader!);
      expect(redirectUrl.origin).toBe("https://slack.com");
      expect(redirectUrl.pathname).toBe("/oauth/v2/authorize");
      expect(redirectUrl.searchParams.get("client_id")).toBe(
        "test-slack-client-id",
      );
      expect(redirectUrl.searchParams.get("scope")).toContain(
        "app_mentions:read",
      );
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        "https://test.example.com/api/slack/oauth/callback",
      );
    });

    it("should use SLACK_REDIRECT_BASE_URL when configured", async () => {
      vi.stubEnv("SLACK_REDIRECT_BASE_URL", "https://tunnel.example.com");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/install",
      );
      const response = await GET(request);

      expect(response.status).toBe(307);

      const locationHeader = response.headers.get("Location");
      const redirectUrl = new URL(locationHeader!);
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
        "https://tunnel.example.com/api/slack/oauth/callback",
      );
    });

    it("should include all required bot scopes", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/slack/oauth/install",
      );
      const response = await GET(request);

      const locationHeader = response.headers.get("Location");
      const redirectUrl = new URL(locationHeader!);
      const scopes = redirectUrl.searchParams.get("scope")!.split(",");

      expect(scopes).toContain("app_mentions:read");
      expect(scopes).toContain("chat:write");
      expect(scopes).toContain("channels:history");
      expect(scopes).toContain("groups:history");
      expect(scopes).toContain("im:history");
      expect(scopes).toContain("commands");
      expect(scopes).toContain("users:read");
    });
  });
});
