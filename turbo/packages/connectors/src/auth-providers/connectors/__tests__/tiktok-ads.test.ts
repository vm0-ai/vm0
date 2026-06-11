import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  connectorAuthClientIdentity,
  getConnectorAuthMethodAuthCodeGrantConfig,
  resolveConnectorAuthClientForMethod,
  type StaticConfidentialConnectorAuthClient,
} from "../../../connector-utils";
import {
  buildTikTokAdsAuthorizationUrl,
  exchangeTikTokAdsCode,
  refreshTikTokAdsToken,
} from "../tiktok-ads/oauth";
import { tiktokAdsProvider } from "../tiktok-ads/provider";
import { server } from "../../__tests__/test-server";

const TOKEN_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";
const REFRESH_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/refresh_token/";
const testAuthClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-client",
  clientSecret: "test-client-secret",
} satisfies StaticConfidentialConnectorAuthClient;

function authCodeGrant() {
  return getConnectorAuthMethodAuthCodeGrantConfig("tiktok-ads", "oauth");
}

describe("connector/providers/tiktok-ads", () => {
  describe("buildTikTokAdsAuthorizationUrl", () => {
    it("builds URL with app_id, redirect_uri, and state", () => {
      const url = buildTikTokAdsAuthorizationUrl(
        authCodeGrant(),
        "test-client-id",
        "https://example.com/callback",
        "test-state",
      );

      expect(url).toContain("app_id=test-client-id");
      expect(url).toContain(
        "redirect_uri=" + encodeURIComponent("https://example.com/callback"),
      );
      expect(url).toContain("state=test-state");
      expect(url).toContain("business-api.tiktok.com/portal/auth");
    });
  });

  describe("exchangeTikTokAdsCode", () => {
    it("exchanges auth_code for access and refresh tokens", async () => {
      const handler = http.post(TOKEN_URL, async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          app_id: "client-id",
          secret: "client-secret",
          auth_code: "test-code",
        });
        return HttpResponse.json({
          data: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 86_400,
            advertiser_ids: ["1234567890"],
          },
          request_id: "request-id",
        });
      });
      server.use(handler);

      const result = await exchangeTikTokAdsCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
      );

      expect(result.accessToken).toBe("access-token");
      expect(result.refreshToken).toBe("refresh-token");
      expect(result.expiresIn).toBe(86_400);
      expect(result.userInfo.id).toBe("1234567890");
      expect(result.userInfo.username).toBe("1234567890");
    });

    it("throws when the API response has a nonzero code", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          code: 40100,
          message: "Authorization code expired",
          request_id: "request-id",
        });
      });
      server.use(handler);

      await expect(
        exchangeTikTokAdsCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "bad-code",
        ),
      ).rejects.toThrow("Authorization code expired");
    });

    it("throws when no access token is returned", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({ data: { refresh_token: "refresh-token" } });
      });
      server.use(handler);

      await expect(
        exchangeTikTokAdsCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
        ),
      ).rejects.toThrow("No access token in TikTok Ads response");
    });
  });

  describe("refreshTikTokAdsToken", () => {
    it("refreshes an access token with the stored refresh token", async () => {
      const handler = http.post(REFRESH_URL, async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          app_id: "client-id",
          secret: "client-secret",
          refresh_token: "current-refresh-token",
        });
        return HttpResponse.json({
          data: {
            access_token: "refreshed-access-token",
            refresh_token: "refreshed-refresh-token",
            expires_in: 86_400,
          },
        });
      });
      server.use(handler);

      await expect(
        refreshTikTokAdsToken(
          "client-id",
          "client-secret",
          "current-refresh-token",
          new AbortController().signal,
        ),
      ).resolves.toStrictEqual({
        accessToken: "refreshed-access-token",
        refreshToken: "refreshed-refresh-token",
        expiresIn: 86_400,
      });
    });
  });

  describe("tiktokAdsProvider", () => {
    it("buildAuthUrl delegates to buildTikTokAdsAuthorizationUrl", () => {
      const url = tiktokAdsProvider.grant.buildAuthUrl({
        authCodeGrant: getConnectorAuthMethodAuthCodeGrantConfig(
          "tiktok-ads",
          "oauth",
        ),
        authClient: connectorAuthClientIdentity(testAuthClient),
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });

      expect(url).toContain("app_id=test-client");
      expect(url).toContain("business-api.tiktok.com/portal/auth");
    });

    it("resolves the OAuth client from TikTok Ads env names", () => {
      const env: Record<string, string> = {
        TIKTOK_ADS_OAUTH_CLIENT_ID: "test-client-id",
        TIKTOK_ADS_OAUTH_CLIENT_SECRET: "test-client-secret",
      };

      expect(
        resolveConnectorAuthClientForMethod("tiktok-ads", "oauth", (name) => {
          return env[name];
        }),
      ).toMatchObject({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
    });

    it("keeps the existing refresh token when refresh does not rotate it", async () => {
      const handler = http.post(REFRESH_URL, () => {
        return HttpResponse.json({
          data: {
            access_token: "provider-refreshed-token",
            expires_in: 86_400,
          },
        });
      });
      server.use(handler);

      await expect(
        tiktokAdsProvider.access.refresh({
          authClient: testAuthClient,
          inputs: {
            refreshToken: "current-refresh-token",
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toStrictEqual({
        outputs: {
          accessToken: "provider-refreshed-token",
          refreshToken: "current-refresh-token",
        },
        expiresIn: 86_400,
      });
    });
  });
});
