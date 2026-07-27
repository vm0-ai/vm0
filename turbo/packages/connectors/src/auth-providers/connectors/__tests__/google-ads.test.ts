import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  connectorAuthClientIdentity,
  type StaticConfidentialConnectorAuthClient,
} from "../../../connector-auth-method";
import { googleAdsProvider } from "../google-ads/provider";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USER_INFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_ADS_SCOPES = [
  "https://www.googleapis.com/auth/adwords",
  "https://www.googleapis.com/auth/datamanager",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;
const testAuthClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-client",
  clientSecret: "test-client-secret",
} satisfies StaticConfidentialConnectorAuthClient;
const AUTH_CODE_GRANT = authCodeGrantFixture(GOOGLE_ADS_SCOPES);

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("connector/providers/google-ads", () => {
  describe("googleAdsProvider", () => {
    it("buildAuthUrl builds Google OAuth URL with Google Ads, Data Manager, and userinfo scopes", () => {
      const url = googleAdsProvider.grant.buildAuthUrl({
        authCodeGrant: AUTH_CODE_GRANT,
        authClient: connectorAuthClientIdentity(testAuthClient),
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
      expect(scopes.has("https://www.googleapis.com/auth/datamanager")).toBe(
        true,
      );
      expect(scopes.has("https://www.googleapis.com/auth/userinfo.email")).toBe(
        true,
      );
    });

    it("refreshToken is defined (uses shared Google token refresh)", () => {
      expect(googleAdsProvider.access.kind).toBe("refresh-token");
    });

    it("exchangeCode maps Google token and user info response", async () => {
      const tokenHandler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "google-ads-access-token",
          refresh_token: "google-ads-refresh-token",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager https://www.googleapis.com/auth/userinfo.email",
        });
      });
      const userInfoHandler = http.get(USER_INFO_URL, () => {
        return HttpResponse.json({
          id: "google-user-123",
          name: "Ada Lovelace",
          email: "ada@example.com",
        });
      });
      server.use(tokenHandler, userInfoHandler);

      const result = await googleAdsProvider.grant.exchangeCode({
        authCodeGrant: AUTH_CODE_GRANT,
        authClient: {
          ...testAuthClient,
          clientId: "client-id",
          clientSecret: "client-secret",
        },
        code: "auth-code",
        redirectUri: "https://example.com/callback",
      });

      expect(result).toEqual({
        outputs: {
          accessToken: "google-ads-access-token",
          refreshToken: "google-ads-refresh-token",
        },
        expiresIn: 3600,
        scopes: [
          "https://www.googleapis.com/auth/adwords",
          "https://www.googleapis.com/auth/datamanager",
          "https://www.googleapis.com/auth/userinfo.email",
        ],
        userInfo: {
          id: "google-user-123",
          username: "Ada Lovelace",
          email: "ada@example.com",
        },
      });
    });

    it("refresh delegates to the shared Google refresh flow", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "refreshed-google-ads-token",
          expires_in: 3600,
        });
      });
      server.use(handler);

      const { access } = googleAdsProvider;

      const result = await access.refresh({
        authClient: {
          ...testAuthClient,
          clientId: "client-id",
          clientSecret: "client-secret",
        },
        inputs: {
          refreshToken: "refresh-token",
        },
        signal: testRefreshSignal(),
      });

      expect(result).toEqual({
        outputs: {
          accessToken: "refreshed-google-ads-token",
        },
        expiresIn: 3600,
      });
    });
  });
});
