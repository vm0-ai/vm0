import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";
import { testContext } from "../../../../../__tests__/test-helpers";
import { reloadEnv } from "../../../../../env";
import { injectPlatformEnvSecrets } from "../../../context/resolve-secrets";
import { CONNECTOR_OAUTH_PROVIDERS } from "@vm0/connectors/oauth-providers";
import { googleAdsHandler } from "@vm0/connectors/oauth-providers/providers/google-ads-handler";

const context = testContext();
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

describe("connector/providers/google-ads", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("googleAdsHandler", () => {
    it("is registered in CONNECTOR_OAUTH_PROVIDERS under google-ads key", () => {
      expect(CONNECTOR_OAUTH_PROVIDERS["google-ads"]).toBe(googleAdsHandler);
    });

    it("buildAuthUrl builds Google OAuth URL with Google Ads and userinfo scopes", () => {
      const url = googleAdsHandler.buildAuthUrl({
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });
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

    it("exchangeCode maps Google token and user info response", async () => {
      const { handler: tokenHandler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "google-ads-access-token",
          refresh_token: "google-ads-refresh-token",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/userinfo.email",
        });
      });
      const { handler: userInfoHandler } = http.get(USER_INFO_URL, () => {
        return HttpResponse.json({
          id: "google-user-123",
          name: "Ada Lovelace",
          email: "ada@example.com",
        });
      });
      server.use(tokenHandler, userInfoHandler);

      const result = await googleAdsHandler.exchangeCode({
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "auth-code",
        redirectUri: "https://example.com/callback",
      });

      expect(result).toEqual({
        accessToken: "google-ads-access-token",
        refreshToken: "google-ads-refresh-token",
        expiresIn: 3600,
        scopes: [
          "https://www.googleapis.com/auth/adwords",
          "https://www.googleapis.com/auth/userinfo.email",
        ],
        userInfo: {
          id: "google-user-123",
          username: "Ada Lovelace",
          email: "ada@example.com",
        },
      });
    });

    it("refreshToken delegates to the shared Google refresh flow", async () => {
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "refreshed-google-ads-token",
          expires_in: 3600,
        });
      });
      server.use(handler);

      const refreshToken = googleAdsHandler.refreshToken;
      if (!refreshToken) {
        throw new Error("Expected Google Ads handler to support refresh");
      }

      const result = await refreshToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      });

      expect(result).toEqual({
        accessToken: "refreshed-google-ads-token",
        refreshToken: null,
        expiresIn: 3600,
      });
    });

    it("does not inject platform env secrets for unrelated connector contexts", () => {
      expect(injectPlatformEnvSecrets(["github"])).toBeUndefined();
    });

    it("injects the Google Ads developer token for google ads contexts", () => {
      vi.stubEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token");
      reloadEnv();

      expect(injectPlatformEnvSecrets(["google-ads"])).toEqual({
        GOOGLE_ADS_DEVELOPER_TOKEN: "developer-token",
      });
    });
  });
});
