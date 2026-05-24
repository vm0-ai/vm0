import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";
import { testContext } from "../../../../../__tests__/test-helpers";
import { getConnectorOAuthCredentials } from "@vm0/connectors/connector-utils";
import { isOAuthConnectorType } from "@vm0/connectors/auth-providers";
import { googleAdsProvider } from "@vm0/connectors/oauth-providers/providers/google-ads-provider";

const context = testContext();
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

describe("connector/providers/google-ads", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("googleAdsProvider", () => {
    it("registers google-ads as an OAuth connector type", () => {
      expect(isOAuthConnectorType("google-ads")).toBe(true);
    });

    it("buildAuthUrl builds Google OAuth URL with Google Ads and userinfo scopes", () => {
      const url = googleAdsProvider.grant.buildAuthUrl({
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

    it("resolves OAuth client credentials from Google env keys", () => {
      const env: Record<string, string> = {
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
      };

      expect(
        getConnectorOAuthCredentials("google-ads", (name) => {
          return env[name];
        }),
      ).toMatchObject({
        configured: true,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
    });

    it("getSecretName returns GOOGLE_ADS_ACCESS_TOKEN", () => {
      expect(googleAdsProvider.access.getAccessSecretName()).toBe(
        "GOOGLE_ADS_ACCESS_TOKEN",
      );
    });

    it("getRefreshSecretName returns GOOGLE_ADS_REFRESH_TOKEN", () => {
      const { access } = googleAdsProvider;
      if (access.kind !== "refresh-token") {
        throw new Error("Expected Google Ads provider to support refresh");
      }

      expect(access.getRefreshSecretName()).toBe("GOOGLE_ADS_REFRESH_TOKEN");
    });

    it("refreshToken is defined (uses shared Google token refresh)", () => {
      expect(googleAdsProvider.access.kind).toBe("refresh-token");
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

      const result = await googleAdsProvider.grant.exchangeCode({
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

      const { access } = googleAdsProvider;
      if (access.kind !== "refresh-token") {
        throw new Error("Expected Google Ads provider to support refresh");
      }

      const result = await access.refreshToken({
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
  });
});
