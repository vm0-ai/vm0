import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  connectorAuthClientIdentity,
  type StaticConfidentialConnectorAuthClient,
} from "../../../connector-auth-method";
import {
  buildTikTokAdsAuthorizationUrl,
  exchangeTikTokAdsCode,
} from "../tiktok-ads/oauth";
import { tiktokAdsProvider } from "../tiktok-ads/provider";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const TOKEN_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";
const testAuthClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-client",
  clientSecret: "test-client-secret",
} satisfies StaticConfidentialConnectorAuthClient;

function authCodeGrant() {
  return authCodeGrantFixture([]);
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
    it("exchanges auth_code for a long-lived access token", async () => {
      const handler = http.post(TOKEN_URL, async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          app_id: "client-id",
          secret: "client-secret",
          auth_code: "test-code",
        });
        return HttpResponse.json({
          data: {
            access_token: "access-token",
            advertiser_ids: ["1234567890"],
            scope: [1, 2, 3],
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
        return HttpResponse.json({ data: { advertiser_ids: ["1234567890"] } });
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

  describe("tiktokAdsProvider", () => {
    it("buildAuthUrl delegates to buildTikTokAdsAuthorizationUrl", () => {
      const url = tiktokAdsProvider.grant.buildAuthUrl({
        authCodeGrant: authCodeGrant(),
        authClient: connectorAuthClientIdentity(testAuthClient),
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });

      expect(url).toContain("app_id=test-client");
      expect(url).toContain("business-api.tiktok.com/portal/auth");
    });

    it("stores only the long-lived access token", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          data: {
            access_token: "provider-access-token",
            advertiser_ids: ["1234567890"],
          },
        });
      });
      server.use(handler);

      await expect(
        tiktokAdsProvider.grant.exchangeCode({
          authCodeGrant: authCodeGrant(),
          authClient: testAuthClient,
          code: "test-code",
          redirectUri: "https://example.com/callback",
        }),
      ).resolves.toStrictEqual({
        outputs: {
          accessToken: "provider-access-token",
        },
        scopes: [],
        userInfo: {
          id: "1234567890",
          username: "1234567890",
          email: null,
        },
      });
    });

    it("does not register a refresh handler", () => {
      expect(tiktokAdsProvider.access).toStrictEqual({
        kind: "none",
      });
    });
  });
});
