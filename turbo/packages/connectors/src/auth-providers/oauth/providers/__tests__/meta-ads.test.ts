import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { getConnectorOAuthClient } from "../../../../connector-utils";
import { isOAuthConnectorType } from "../../../connector-auth";
import {
  buildMetaAdsAuthorizationUrl,
  exchangeMetaAdsCode,
  getMetaAdsSecretName,
} from "../meta-ads";
import { metaAdsProvider } from "../meta-ads-provider";
import { server } from "./test-server";

const TOKEN_URL = "https://graph.facebook.com/v22.0/oauth/access_token";
const USER_URL = "https://graph.facebook.com/v22.0/me";

describe("connector/providers/meta-ads", () => {
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

  describe("metaAdsProvider", () => {
    it("registers meta-ads as an OAuth connector type", () => {
      expect(isOAuthConnectorType("meta-ads")).toBe(true);
    });

    it("buildAuthUrl delegates to buildMetaAdsAuthorizationUrl", () => {
      const url = metaAdsProvider.grant.buildAuthUrl({
        clientId: "test-client",
        redirectUri: "https://example.com/callback",
        state: "test-state",
      });

      expect(url).toContain("client_id=test-client");
      expect(url).toContain("facebook.com/v22.0/dialog/oauth");
    });

    it("resolves the OAuth client from Meta Ads env keys", () => {
      const env: Record<string, string> = {
        META_ADS_OAUTH_CLIENT_ID: "test-client-id",
        META_ADS_OAUTH_CLIENT_SECRET: "test-client-secret",
      };

      expect(
        getConnectorOAuthClient("meta-ads", (name) => {
          return env[name];
        }),
      ).toMatchObject({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      });
    });

    it("getSecretName returns META_ADS_ACCESS_TOKEN", () => {
      expect(metaAdsProvider.access.getAccessSecretName()).toBe(
        "META_ADS_ACCESS_TOKEN",
      );
    });

    it("refreshToken is not registered (Meta uses long-lived token exchange)", () => {
      expect(metaAdsProvider.access.kind).toBe("none");
    });
  });
});
