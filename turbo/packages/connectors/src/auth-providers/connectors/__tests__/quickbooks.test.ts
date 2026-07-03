import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { getConnectorAuthMethodAuthCodeGrantConfig } from "../../../connector-utils";
import {
  buildQuickBooksAuthorizationUrl,
  exchangeQuickBooksCode,
  getQuickBooksSecretName,
  refreshQuickBooksToken,
} from "../quickbooks/oauth";
import { server } from "../../__tests__/test-server";

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

function authCodeGrant() {
  return getConnectorAuthMethodAuthCodeGrantConfig("quickbooks", "oauth");
}

describe("connector/providers/quickbooks", () => {
  describe("buildQuickBooksAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, response_type, and scope", () => {
      const url = buildQuickBooksAuthorizationUrl(
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
      expect(url).toContain("appcenter.intuit.com/connect/oauth2");
    });
  });

  describe("exchangeQuickBooksCode", () => {
    it("exchanges code for access token, user info, and realmId", async () => {
      let authorization: string | null = null;
      const tokenHandler = http.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        ({ request }) => {
          authorization = request.headers.get("authorization");
          return HttpResponse.json({
            access_token: "quickbooks-test-token",
            refresh_token: "quickbooks-refresh-token",
            expires_in: 3600,
            scope: "com.intuit.quickbooks.accounting openid profile email",
          });
        },
      );
      const userInfoHandler = http.get(
        "https://accounts.platform.intuit.com/v1/openid_connect/userinfo",
        () => {
          return HttpResponse.json({
            sub: "intuit-user-123",
            email: "test@example.com",
            givenName: "Test",
            familyName: "User",
          });
        },
      );
      server.use(tokenHandler, userInfoHandler);

      const result = await exchangeQuickBooksCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
        JSON.stringify({ realmId: "1234567890" }),
      );

      expect(authorization).toBe(`Basic ${btoa("client-id:client-secret")}`);
      expect(result.accessToken).toBe("quickbooks-test-token");
      expect(result.refreshToken).toBe("quickbooks-refresh-token");
      expect(result.realmId).toBe("1234567890");
      expect(result.expiresIn).toBe(3600);
      expect(result.scopes).toEqual([
        "com.intuit.quickbooks.accounting",
        "openid",
        "profile",
        "email",
      ]);
      expect(result.userInfo.id).toBe("intuit-user-123");
      expect(result.userInfo.username).toBe("Test User");
      expect(result.userInfo.email).toBe("test@example.com");
    });

    it("throws when realmId is missing from OAuth callback context", async () => {
      const tokenHandler = http.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        () => {
          return HttpResponse.json({
            access_token: "quickbooks-test-token",
            refresh_token: "quickbooks-refresh-token",
          });
        },
      );
      const userInfoHandler = http.get(
        "https://accounts.platform.intuit.com/v1/openid_connect/userinfo",
        () => {
          return HttpResponse.json({
            sub: "intuit-user-123",
            email: "test@example.com",
          });
        },
      );
      server.use(tokenHandler, userInfoHandler);

      await expect(
        exchangeQuickBooksCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
          undefined,
        ),
      ).rejects.toThrow("QuickBooks realmId missing from OAuth callback");
    });

    it("throws when no access token in response", async () => {
      const tokenHandler = http.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        () => {
          return HttpResponse.json({});
        },
      );
      server.use(tokenHandler);

      await expect(
        exchangeQuickBooksCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
          JSON.stringify({ realmId: "1234567890" }),
        ),
      ).rejects.toThrow("No access token in QuickBooks response");
    });
  });

  describe("refreshQuickBooksToken", () => {
    it("refreshes access token successfully", async () => {
      const handler = http.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        () => {
          return HttpResponse.json({
            access_token: "new-quickbooks-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          });
        },
      );
      server.use(handler);

      const result = await refreshQuickBooksToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
        testRefreshSignal(),
      );

      expect(result.accessToken).toBe("new-quickbooks-token");
      expect(result.refreshToken).toBe("new-refresh-token");
      expect(result.expiresIn).toBe(3600);
    });

    it("throws when refresh returns an error", async () => {
      const handler = http.post(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        () => {
          return HttpResponse.json({
            error: "invalid_grant",
            error_description: "Refresh token revoked",
          });
        },
      );
      server.use(handler);

      await expect(
        refreshQuickBooksToken(
          "client-id",
          "client-secret",
          "bad-refresh-token",
          testRefreshSignal(),
        ),
      ).rejects.toThrow("Refresh token revoked");
    });
  });

  describe("getQuickBooksSecretName", () => {
    it("returns the expected secret name", () => {
      expect(getQuickBooksSecretName()).toBe("QUICKBOOKS_ACCESS_TOKEN");
    });
  });
});
