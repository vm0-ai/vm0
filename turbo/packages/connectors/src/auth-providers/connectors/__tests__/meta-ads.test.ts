import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  connectorAuthClientIdentity,
  getConnectorAuthMethodAuthCodeGrantConfig,
  resolveConnectorAuthClientForMethod,
  type StaticConfidentialConnectorAuthClient,
} from "../../../connector-utils";
import {
  buildMetaAdsAuthorizationUrl,
  exchangeMetaAdsCode,
  getMetaAdsSecretName,
  refreshMetaAdsLongLivedToken,
} from "../meta-ads/oauth";
import { metaAdsProvider } from "../meta-ads/provider";
import { server } from "../../__tests__/test-server";

const TOKEN_URL = "https://graph.facebook.com/v22.0/oauth/access_token";
const USER_URL = "https://graph.facebook.com/v22.0/me";
const testAuthClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-client",
  clientSecret: "test-client-secret",
} satisfies StaticConfidentialConnectorAuthClient;

function authCodeGrant() {
  return getConnectorAuthMethodAuthCodeGrantConfig("meta-ads", "oauth");
}

describe("connector/providers/meta-ads", () => {
  describe("buildMetaAdsAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, and scopes", () => {
      const url = buildMetaAdsAuthorizationUrl(
        authCodeGrant(),
        "test-client-id",
        "https://example.com/callback",
        "test-state",
      );

      expect(url).toContain("client_id=test-client-id");
      expect(url).toContain(
        "redirect_uri=" + encodeURIComponent("https://example.com/callback"),
      );
      expect(url).toContain("state=test-state");
      expect(url).toContain("response_type=code");
      expect(url).toContain("scope=");
      expect(url).toContain("facebook.com/v22.0/dialog/oauth");
      const scopes = new Set(
        new URL(url).searchParams.get("scope")?.split(",") ?? [],
      );
      expect(scopes).toStrictEqual(
        new Set([
          "ads_management",
          "ads_read",
          "business_management",
          "pages_manage_ads",
          "pages_read_engagement",
          "pages_show_list",
          "public_profile",
        ]),
      );
      expect(scopes.has("email")).toBe(false);
    });
  });

  describe("exchangeMetaAdsCode", () => {
    it("exchanges code for short-lived token then long-lived token", async () => {
      const shortLivedHandler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "short-lived-token",
          token_type: "bearer",
          expires_in: 3600,
        });
      });
      const longLivedHandler = http.get(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "long-lived-token",
          token_type: "bearer",
          expires_in: 5184000,
        });
      });
      const userHandler = http.get(USER_URL, () => {
        return HttpResponse.json({
          id: "12345",
          name: "Test User",
          email: "test@example.com",
        });
      });
      server.use(shortLivedHandler, longLivedHandler, userHandler);

      const result = await exchangeMetaAdsCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("long-lived-token");
      expect(result.expiresIn).toBe(5184000);
      expect(result.userInfo.id).toBe("12345");
      expect(result.userInfo.username).toBe("Test User");
      expect(result.userInfo.email).toBe("test@example.com");
    });

    it("throws when token endpoint returns an error", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Invalid authorization code",
              type: "OAuthException",
              code: 100,
            },
          },
          { status: 400 },
        );
      });
      server.use(handler);

      await expect(
        exchangeMetaAdsCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "bad-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Invalid authorization code");
    });

    it("throws when no access token in response", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(
        exchangeMetaAdsCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("No access token in Meta Ads response");
    });

    it("throws when token endpoint returns HTTP error", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      });
      server.use(handler);

      await expect(
        exchangeMetaAdsCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Meta Ads token exchange failed");
    });
  });

  describe("refreshMetaAdsLongLivedToken", () => {
    it("refreshes a long-lived access token through fb_exchange_token", async () => {
      const handler = http.get(TOKEN_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("grant_type")).toBe("fb_exchange_token");
        expect(url.searchParams.get("client_id")).toBe("client-id");
        expect(url.searchParams.get("client_secret")).toBe("client-secret");
        expect(url.searchParams.get("fb_exchange_token")).toBe(
          "current-long-lived-token",
        );
        return HttpResponse.json({
          access_token: "refreshed-long-lived-token",
          token_type: "bearer",
          expires_in: 5184000,
        });
      });
      server.use(handler);

      await expect(
        refreshMetaAdsLongLivedToken(
          "client-id",
          "client-secret",
          "current-long-lived-token",
          new AbortController().signal,
        ),
      ).resolves.toStrictEqual({
        accessToken: "refreshed-long-lived-token",
        expiresIn: 5184000,
      });
    });
  });

  describe("getMetaAdsSecretName", () => {
    it("returns the expected secret name", () => {
      expect(getMetaAdsSecretName()).toBe("META_ADS_ACCESS_TOKEN");
    });
  });

  describe("metaAdsProvider", () => {
    it("buildAuthUrl delegates to buildMetaAdsAuthorizationUrl", () => {
      const url = metaAdsProvider.grant.buildAuthUrl({
        authCodeGrant: getConnectorAuthMethodAuthCodeGrantConfig(
          "meta-ads",
          "oauth",
        ),
        authClient: connectorAuthClientIdentity(testAuthClient),
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });

      expect(url).toContain("client_id=test-client");
      expect(url).toContain("facebook.com/v22.0/dialog/oauth");
    });

    it("resolves the OAuth client from Meta Ads env names", () => {
      const env: Record<string, string> = {
        META_ADS_OAUTH_CLIENT_ID: "test-client-id",
        META_ADS_OAUTH_CLIENT_SECRET: "test-client-secret",
      };

      expect(
        resolveConnectorAuthClientForMethod("meta-ads", "oauth", (name) => {
          return env[name];
        }),
      ).toMatchObject({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
    });

    it("refreshes the stored long-lived access token", async () => {
      const handler = http.get(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "provider-refreshed-token",
          token_type: "bearer",
          expires_in: 5184000,
        });
      });
      server.use(handler);

      await expect(
        metaAdsProvider.access.refresh({
          authClient: testAuthClient,
          inputs: {
            refreshToken: "current-long-lived-token",
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toStrictEqual({
        outputs: {
          accessToken: "provider-refreshed-token",
          refreshToken: "provider-refreshed-token",
        },
        expiresIn: 5184000,
      });
    });
  });
});
