import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";
import { testContext } from "../../../../../__tests__/test-helpers";
import {
  buildZoomAuthorizationUrl,
  exchangeZoomCode,
  refreshZoomToken,
  getZoomSecretName,
} from "@vm0/connectors/auth-providers/oauth/providers/zoom";

const context = testContext();

describe("connector/providers/zoom", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("buildZoomAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, and response_type", () => {
      const url = buildZoomAuthorizationUrl(
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
      expect(url).toContain("zoom.us/oauth/authorize");
    });
  });

  describe("exchangeZoomCode", () => {
    it("exchanges code for access token and user info", async () => {
      const { handler: tokenHandler } = http.post(
        "https://zoom.us/oauth/token",
        () => {
          return HttpResponse.json({
            access_token: "zoom-test-token",
            refresh_token: "zoom-refresh-token",
            expires_in: 3599,
            scope: "meeting:read:list_meetings user:read:user",
          });
        },
      );
      const { handler: meHandler } = http.get(
        "https://api.zoom.us/v2/users/me",
        () => {
          return HttpResponse.json({
            id: "zoom-user-123",
            email: "test@example.com",
            first_name: "Test",
            last_name: "User",
            display_name: "Test User",
          });
        },
      );
      server.use(tokenHandler, meHandler);

      const result = await exchangeZoomCode(
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("zoom-test-token");
      expect(result.refreshToken).toBe("zoom-refresh-token");
      expect(result.expiresIn).toBe(3599);
      expect(result.scopes).toEqual([
        "meeting:read:list_meetings",
        "user:read:user",
      ]);
      expect(result.userInfo.id).toBe("zoom-user-123");
      expect(result.userInfo.username).toBe("Test User");
      expect(result.userInfo.email).toBe("test@example.com");
    });

    it("throws when Zoom returns an error in response body", async () => {
      const { handler: tokenHandler } = http.post(
        "https://zoom.us/oauth/token",
        () => {
          return HttpResponse.json({
            error: "invalid_grant",
            error_description: "Invalid authorization code",
          });
        },
      );
      server.use(tokenHandler);

      await expect(
        exchangeZoomCode(
          "client-id",
          "client-secret",
          "bad-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Invalid authorization code");
    });

    it("throws when no access token in response", async () => {
      const { handler: tokenHandler } = http.post(
        "https://zoom.us/oauth/token",
        () => {
          return HttpResponse.json({});
        },
      );
      server.use(tokenHandler);

      await expect(
        exchangeZoomCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("No access token in Zoom response");
    });

    it("throws when token endpoint returns HTTP error", async () => {
      const { handler: tokenHandler } = http.post(
        "https://zoom.us/oauth/token",
        () => {
          return new HttpResponse("Unauthorized", { status: 401 });
        },
      );
      server.use(tokenHandler);

      await expect(
        exchangeZoomCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Zoom token exchange failed");
    });
  });

  describe("refreshZoomToken", () => {
    it("refreshes access token successfully", async () => {
      const { handler } = http.post("https://zoom.us/oauth/token", () => {
        return HttpResponse.json({
          access_token: "new-zoom-token",
          refresh_token: "new-refresh-token",
          expires_in: 3599,
        });
      });
      server.use(handler);

      const result = await refreshZoomToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
      );

      expect(result.accessToken).toBe("new-zoom-token");
      expect(result.refreshToken).toBe("new-refresh-token");
      expect(result.expiresIn).toBe(3599);
    });

    it("throws when refresh returns an error", async () => {
      const { handler } = http.post("https://zoom.us/oauth/token", () => {
        return HttpResponse.json({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        });
      });
      server.use(handler);

      await expect(
        refreshZoomToken("client-id", "client-secret", "bad-refresh-token"),
      ).rejects.toThrow("Refresh token revoked");
    });

    it("throws when no access token in refresh response", async () => {
      const { handler } = http.post("https://zoom.us/oauth/token", () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(
        refreshZoomToken("client-id", "client-secret", "refresh-token"),
      ).rejects.toThrow("No access token in Zoom refresh response");
    });

    it("throws when refresh endpoint returns HTTP error", async () => {
      const { handler } = http.post("https://zoom.us/oauth/token", () => {
        return new HttpResponse("Bad Request", { status: 400 });
      });
      server.use(handler);

      await expect(
        refreshZoomToken("client-id", "client-secret", "refresh-token"),
      ).rejects.toThrow("Zoom token refresh failed");
    });
  });

  describe("getZoomSecretName", () => {
    it("returns the expected secret name", () => {
      expect(getZoomSecretName()).toBe("ZOOM_ACCESS_TOKEN");
    });
  });
});
