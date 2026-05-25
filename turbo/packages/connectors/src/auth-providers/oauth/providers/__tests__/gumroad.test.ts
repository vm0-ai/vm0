import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  buildGumroadAuthorizationUrl,
  exchangeGumroadCode,
  getGumroadSecretName,
  refreshGumroadToken,
} from "../gumroad";
import { server } from "./test-server";

describe("connector/providers/gumroad", () => {
  describe("buildGumroadAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, and scope", () => {
      const url = buildGumroadAuthorizationUrl(
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
      expect(url).toContain("gumroad.com");
    });
  });

  describe("exchangeGumroadCode", () => {
    it("exchanges code for access token and user info", async () => {
      const tokenHandler = http.post("https://gumroad.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: "gumroad-test-token",
          scope: "view_profile edit_products view_sales",
        });
      });
      const userHandler = http.get("https://api.gumroad.com/v2/user", () => {
        return HttpResponse.json({
          user: {
            id: "gumroad-user-123",
            name: "Test Creator",
            email: "creator@example.com",
          },
        });
      });
      server.use(tokenHandler, userHandler);

      const result = await exchangeGumroadCode(
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("gumroad-test-token");
      expect(result.refreshToken).toBeNull();
      expect(result.scopes).toEqual([
        "view_profile",
        "edit_products",
        "view_sales",
      ]);
      expect(result.userInfo.id).toBe("gumroad-user-123");
      expect(result.userInfo.username).toBe("Test Creator");
      expect(result.userInfo.email).toBe("creator@example.com");
    });

    it("throws when Gumroad returns an error in response body", async () => {
      const handler = http.post("https://gumroad.com/oauth/token", () => {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: "Authorization code expired",
        });
      });
      server.use(handler);

      await expect(
        exchangeGumroadCode(
          "client-id",
          "client-secret",
          "bad-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Authorization code expired");
    });

    it("throws when no access token in response", async () => {
      const handler = http.post("https://gumroad.com/oauth/token", () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(
        exchangeGumroadCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("No access token in Gumroad response");
    });

    it("throws when token endpoint returns HTTP error", async () => {
      const handler = http.post("https://gumroad.com/oauth/token", () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      });
      server.use(handler);

      await expect(
        exchangeGumroadCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Gumroad token exchange failed");
    });
  });

  describe("refreshGumroadToken", () => {
    it("refreshes access token successfully", async () => {
      const handler = http.post("https://gumroad.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: "new-gumroad-token",
          refresh_token: "new-refresh-token",
        });
      });
      server.use(handler);

      const result = await refreshGumroadToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
      );

      expect(result.accessToken).toBe("new-gumroad-token");
      expect(result.refreshToken).toBe("new-refresh-token");
    });

    it("throws when refresh returns an error", async () => {
      const handler = http.post("https://gumroad.com/oauth/token", () => {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        });
      });
      server.use(handler);

      await expect(
        refreshGumroadToken("client-id", "client-secret", "bad-refresh-token"),
      ).rejects.toThrow("Refresh token revoked");
    });

    it("throws when no access token in refresh response", async () => {
      const handler = http.post("https://gumroad.com/oauth/token", () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(
        refreshGumroadToken("client-id", "client-secret", "refresh-token"),
      ).rejects.toThrow("No access token in Gumroad refresh response");
    });

    it("throws when refresh endpoint returns HTTP error", async () => {
      const handler = http.post("https://gumroad.com/oauth/token", () => {
        return new HttpResponse("Bad Request", { status: 400 });
      });
      server.use(handler);

      await expect(
        refreshGumroadToken("client-id", "client-secret", "refresh-token"),
      ).rejects.toThrow("Gumroad token refresh failed");
    });
  });

  describe("getGumroadSecretName", () => {
    it("returns the expected secret name", () => {
      expect(getGumroadSecretName()).toBe("GUMROAD_ACCESS_TOKEN");
    });
  });
});
