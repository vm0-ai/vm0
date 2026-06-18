import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { getConnectorAuthMethodAuthCodeGrantConfig } from "../../../connector-utils";
import {
  buildBoxAuthorizationUrl,
  exchangeBoxCode,
  getBoxSecretName,
  refreshBoxToken,
} from "../box/oauth";
import { server } from "../../__tests__/test-server";

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

function authCodeGrant() {
  return getConnectorAuthMethodAuthCodeGrantConfig("box", "oauth");
}

describe("connector/providers/box", () => {
  describe("buildBoxAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, response_type, and scope", () => {
      const url = buildBoxAuthorizationUrl(
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
      expect(url).toContain("scope=root_readwrite");
      expect(url).toContain("account.box.com/api/oauth2/authorize");
    });
  });

  describe("exchangeBoxCode", () => {
    it("exchanges code for access token and user info", async () => {
      const tokenHandler = http.post("https://api.box.com/oauth2/token", () => {
        return HttpResponse.json({
          access_token: "box-test-token",
          refresh_token: "box-refresh-token",
          expires_in: 3600,
          scope: "root_readwrite",
        });
      });
      const meHandler = http.get("https://api.box.com/2.0/users/me", () => {
        return HttpResponse.json({
          id: "box-user-123",
          name: "Test User",
          login: "test@example.com",
        });
      });
      server.use(tokenHandler, meHandler);

      const result = await exchangeBoxCode(
        authCodeGrant(),
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("box-test-token");
      expect(result.refreshToken).toBe("box-refresh-token");
      expect(result.expiresIn).toBe(3600);
      expect(result.scopes).toEqual(["root_readwrite"]);
      expect(result.userInfo.id).toBe("box-user-123");
      expect(result.userInfo.username).toBe("Test User");
      expect(result.userInfo.email).toBe("test@example.com");
    });

    it("throws when Box returns an error in response body", async () => {
      const tokenHandler = http.post("https://api.box.com/oauth2/token", () => {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: "Invalid authorization code",
        });
      });
      server.use(tokenHandler);

      await expect(
        exchangeBoxCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "bad-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Invalid authorization code");
    });

    it("throws when no access token in response", async () => {
      const tokenHandler = http.post("https://api.box.com/oauth2/token", () => {
        return HttpResponse.json({});
      });
      server.use(tokenHandler);

      await expect(
        exchangeBoxCode(
          authCodeGrant(),
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("No access token in Box response");
    });
  });

  describe("refreshBoxToken", () => {
    it("refreshes access token successfully", async () => {
      const handler = http.post("https://api.box.com/oauth2/token", () => {
        return HttpResponse.json({
          access_token: "new-box-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        });
      });
      server.use(handler);

      const result = await refreshBoxToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
        testRefreshSignal(),
      );

      expect(result.accessToken).toBe("new-box-token");
      expect(result.refreshToken).toBe("new-refresh-token");
      expect(result.expiresIn).toBe(3600);
    });

    it("throws when refresh returns an error", async () => {
      const handler = http.post("https://api.box.com/oauth2/token", () => {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        });
      });
      server.use(handler);

      await expect(
        refreshBoxToken(
          "client-id",
          "client-secret",
          "bad-refresh-token",
          testRefreshSignal(),
        ),
      ).rejects.toThrow("Refresh token revoked");
    });
  });

  describe("getBoxSecretName", () => {
    it("returns the expected secret name", () => {
      expect(getBoxSecretName()).toBe("BOX_ACCESS_TOKEN");
    });
  });
});
