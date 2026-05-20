import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";
import { testContext } from "../../../../../__tests__/test-helpers";
import { CONNECTOR_OAUTH_PROVIDERS } from "@vm0/connectors/oauth-providers";
import {
  buildMetaAdsAuthorizationUrl,
  exchangeMetaAdsCode,
  getMetaAdsSecretName,
} from "@vm0/connectors/oauth-providers/providers/meta-ads";
import { metaAdsHandler } from "@vm0/connectors/oauth-providers/providers/meta-ads-handler";

const TOKEN_URL = "https://graph.facebook.com/v22.0/oauth/access_token";
const USER_URL = "https://graph.facebook.com/v22.0/me";

const context = testContext();

describe("connector/providers/meta-ads", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("buildMetaAdsAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, and scopes", () => {
      const url = buildMetaAdsAuthorizationUrl(
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
    });
  });

  describe("exchangeMetaAdsCode", () => {
    it("exchanges code for short-lived token then long-lived token", async () => {
      const { handler: shortLivedHandler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "short-lived-token",
          token_type: "bearer",
          expires_in: 3600,
        });
      });
      const { handler: longLivedHandler } = http.get(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "long-lived-token",
          token_type: "bearer",
          expires_in: 5184000,
        });
      });
      const { handler: userHandler } = http.get(USER_URL, () => {
        return HttpResponse.json({
          id: "12345",
          name: "Test User",
          email: "test@example.com",
        });
      });
      server.use(shortLivedHandler, longLivedHandler, userHandler);

      const result = await exchangeMetaAdsCode(
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("long-lived-token");
      expect(result.refreshToken).toBeNull();
      expect(result.expiresIn).toBe(5184000);
      expect(result.userInfo.id).toBe("12345");
      expect(result.userInfo.username).toBe("Test User");
      expect(result.userInfo.email).toBe("test@example.com");
    });

    it("throws when token endpoint returns an error", async () => {
      const { handler } = http.post(TOKEN_URL, () => {
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
          "client-id",
          "client-secret",
          "bad-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Invalid authorization code");
    });

    it("throws when no access token in response", async () => {
      const { handler } = http.post(TOKEN_URL, () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(
        exchangeMetaAdsCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("No access token in Meta Ads response");
    });

    it("throws when token endpoint returns HTTP error", async () => {
      const { handler } = http.post(TOKEN_URL, () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      });
      server.use(handler);

      await expect(
        exchangeMetaAdsCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Meta Ads token exchange failed");
    });
  });

  describe("getMetaAdsSecretName", () => {
    it("returns the expected secret name", () => {
      expect(getMetaAdsSecretName()).toBe("META_ADS_ACCESS_TOKEN");
    });
  });

  describe("metaAdsHandler", () => {
    it("is registered in CONNECTOR_OAUTH_PROVIDERS under meta-ads key", () => {
      expect(CONNECTOR_OAUTH_PROVIDERS["meta-ads"]).toBe(metaAdsHandler);
    });

    it("buildAuthUrl delegates to buildMetaAdsAuthorizationUrl", () => {
      const url = metaAdsHandler.buildAuthUrl({
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });

      expect(url).toContain("client_id=test-client");
      expect(url).toContain("facebook.com/v22.0/dialog/oauth");
    });

    it("getClientId returns META_ADS_OAUTH_CLIENT_ID from env", () => {
      const env = {
        META_ADS_OAUTH_CLIENT_ID: "test-client-id",
      } as Parameters<typeof metaAdsHandler.getClientId>[0];

      expect(metaAdsHandler.getClientId(env)).toBe("test-client-id");
    });

    it("getClientSecret returns META_ADS_OAUTH_CLIENT_SECRET from env", () => {
      const env = {
        META_ADS_OAUTH_CLIENT_SECRET: "test-client-secret",
      } as Parameters<typeof metaAdsHandler.getClientSecret>[0];

      expect(metaAdsHandler.getClientSecret(env)).toBe("test-client-secret");
    });

    it("getSecretName returns META_ADS_ACCESS_TOKEN", () => {
      expect(metaAdsHandler.getSecretName()).toBe("META_ADS_ACCESS_TOKEN");
    });

    it("refreshToken is not registered (Meta uses long-lived token exchange)", () => {
      expect("refreshToken" in metaAdsHandler).toBe(false);
    });
  });
});
