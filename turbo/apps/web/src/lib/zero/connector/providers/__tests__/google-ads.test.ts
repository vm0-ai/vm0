import { describe, it, expect, beforeEach } from "vitest";
import { testContext } from "../../../../../__tests__/test-helpers";
import { PROVIDER_HANDLERS } from "../../provider-registry";
import { googleAdsHandler } from "../google-ads-handler";

const context = testContext();

describe("connector/providers/google-ads", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("googleAdsHandler", () => {
    it("is registered in PROVIDER_HANDLERS under google-ads key", () => {
      expect(PROVIDER_HANDLERS["google-ads"]).toBe(googleAdsHandler);
    });

    it("buildAuthUrl builds Google OAuth URL with Google Ads and userinfo scopes", () => {
      const url = googleAdsHandler.buildAuthUrl(
        "test-client",
        "https://example.com/callback",
        "test-state",
      );
      if (typeof url !== "string") {
        throw new Error("Expected Google Ads auth URL to be a string");
      }
      const params = new URL(url).searchParams;
      const scopes = new Set(params.get("scope")?.split(" ") ?? []);

      expect(url).toContain("client_id=test-client");
      expect(url).toContain(
        "redirect_uri=" + encodeURIComponent("https://example.com/callback"),
      );
      expect(url).toContain("state=test-state");
      expect(url).toContain("response_type=code");
      expect(url).toContain("access_type=offline");
      expect(url).toContain("prompt=consent");
      expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(scopes.has("https://www.googleapis.com/auth/adwords")).toBe(true);
      expect(scopes.has("https://www.googleapis.com/auth/userinfo.email")).toBe(
        true,
      );
    });

    it("getClientId returns GOOGLE_OAUTH_CLIENT_ID from env", () => {
      const env = {
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
      } as Parameters<typeof googleAdsHandler.getClientId>[0];

      expect(googleAdsHandler.getClientId(env)).toBe("test-client-id");
    });

    it("getClientSecret returns GOOGLE_OAUTH_CLIENT_SECRET from env", () => {
      const env = {
        GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
      } as Parameters<typeof googleAdsHandler.getClientSecret>[0];

      expect(googleAdsHandler.getClientSecret(env)).toBe("test-client-secret");
    });

    it("getSecretName returns GOOGLE_ADS_ACCESS_TOKEN", () => {
      expect(googleAdsHandler.getSecretName()).toBe("GOOGLE_ADS_ACCESS_TOKEN");
    });

    it("getRefreshSecretName returns GOOGLE_ADS_REFRESH_TOKEN", () => {
      expect(googleAdsHandler.getRefreshSecretName?.()).toBe(
        "GOOGLE_ADS_REFRESH_TOKEN",
      );
    });

    it("refreshToken is defined (uses shared Google token refresh)", () => {
      expect(googleAdsHandler.refreshToken).toBeDefined();
    });
  });
});
