import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";
import { testContext } from "../../../../../__tests__/test-helpers";
import {
  buildSpotifyAuthorizationUrl,
  exchangeSpotifyCode,
  refreshSpotifyToken,
  getSpotifySecretName,
} from "@vm0/connectors/auth-providers/oauth/providers/spotify";

const context = testContext();

describe("connector/providers/spotify", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("buildSpotifyAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, and scope", () => {
      const url = buildSpotifyAuthorizationUrl(
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
      expect(url).toContain("accounts.spotify.com");
    });
  });

  describe("exchangeSpotifyCode", () => {
    it("exchanges code for access token and user info", async () => {
      const { handler: tokenHandler } = http.post(
        "https://accounts.spotify.com/api/token",
        () => {
          return HttpResponse.json({
            access_token: "spotify-test-token",
            refresh_token: "spotify-refresh-token",
            expires_in: 3600,
            scope: "user-read-email user-read-private",
          });
        },
      );
      const { handler: meHandler } = http.get(
        "https://api.spotify.com/v1/me",
        () => {
          return HttpResponse.json({
            id: "spotify-user-123",
            display_name: "Test Spotify User",
            email: "test@example.com",
          });
        },
      );
      server.use(tokenHandler, meHandler);

      const result = await exchangeSpotifyCode(
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("spotify-test-token");
      expect(result.refreshToken).toBe("spotify-refresh-token");
      expect(result.expiresIn).toBe(3600);
      expect(result.scopes).toEqual(["user-read-email", "user-read-private"]);
      expect(result.userInfo.id).toBe("spotify-user-123");
      expect(result.userInfo.username).toBe("Test Spotify User");
      expect(result.userInfo.email).toBe("test@example.com");
    });

    it("throws when Spotify returns an error in response body", async () => {
      const { handler: tokenHandler } = http.post(
        "https://accounts.spotify.com/api/token",
        () => {
          return HttpResponse.json({
            error: "invalid_grant",
            error_description: "Authorization code expired",
          });
        },
      );
      server.use(tokenHandler);

      await expect(
        exchangeSpotifyCode(
          "client-id",
          "client-secret",
          "bad-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Authorization code expired");
    });

    it("throws when no access token in response", async () => {
      const { handler: tokenHandler } = http.post(
        "https://accounts.spotify.com/api/token",
        () => {
          return HttpResponse.json({});
        },
      );
      server.use(tokenHandler);

      await expect(
        exchangeSpotifyCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("No access token in Spotify response");
    });

    it("throws when token endpoint returns HTTP error", async () => {
      const { handler: tokenHandler } = http.post(
        "https://accounts.spotify.com/api/token",
        () => {
          return new HttpResponse("Internal Server Error", { status: 500 });
        },
      );
      server.use(tokenHandler);

      await expect(
        exchangeSpotifyCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("Spotify token exchange failed");
    });
  });

  describe("refreshSpotifyToken", () => {
    it("refreshes access token successfully", async () => {
      const { handler } = http.post(
        "https://accounts.spotify.com/api/token",
        () => {
          return HttpResponse.json({
            access_token: "new-spotify-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          });
        },
      );
      server.use(handler);

      const result = await refreshSpotifyToken(
        "client-id",
        "client-secret",
        "old-refresh-token",
      );

      expect(result.accessToken).toBe("new-spotify-token");
      expect(result.refreshToken).toBe("new-refresh-token");
      expect(result.expiresIn).toBe(3600);
    });

    it("throws when refresh returns an error", async () => {
      const { handler } = http.post(
        "https://accounts.spotify.com/api/token",
        () => {
          return HttpResponse.json({
            error: "invalid_grant",
            error_description: "Refresh token revoked",
          });
        },
      );
      server.use(handler);

      await expect(
        refreshSpotifyToken("client-id", "client-secret", "bad-refresh-token"),
      ).rejects.toThrow("Refresh token revoked");
    });

    it("throws when no access token in refresh response", async () => {
      const { handler } = http.post(
        "https://accounts.spotify.com/api/token",
        () => {
          return HttpResponse.json({});
        },
      );
      server.use(handler);

      await expect(
        refreshSpotifyToken("client-id", "client-secret", "refresh-token"),
      ).rejects.toThrow("No access token in Spotify refresh response");
    });

    it("throws when refresh endpoint returns HTTP error", async () => {
      const { handler } = http.post(
        "https://accounts.spotify.com/api/token",
        () => {
          return new HttpResponse("Bad Request", { status: 400 });
        },
      );
      server.use(handler);

      await expect(
        refreshSpotifyToken("client-id", "client-secret", "refresh-token"),
      ).rejects.toThrow("Spotify token refresh failed");
    });
  });

  describe("getSpotifySecretName", () => {
    it("returns the expected secret name", () => {
      expect(getSpotifySecretName()).toBe("SPOTIFY_ACCESS_TOKEN");
    });
  });
});
