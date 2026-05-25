import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import {
  buildSlackAuthorizationUrl,
  exchangeSlackCode,
  fetchSlackUserInfo,
  getSlackSecretName,
  revokeSlackToken,
} from "../slack";
import { server } from "./test-server";

describe("connector/providers/slack", () => {
  describe("buildSlackAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, and user_scope", () => {
      const url = buildSlackAuthorizationUrl(
        "test-client-id",
        "https://example.com/callback",
        "test-state",
      );

      expect(url).toContain("client_id=test-client-id");
      expect(url).toContain(
        "redirect_uri=" + encodeURIComponent("https://example.com/callback"),
      );
      expect(url).toContain("state=test-state");
      expect(url).toContain("user_scope=");
    });
  });

  describe("exchangeSlackCode", () => {
    it("exchanges code for access token", async () => {
      const handler = http.post("https://slack.com/api/oauth.v2.access", () => {
        return HttpResponse.json({
          ok: true,
          authed_user: {
            id: "U-test",
            access_token: "xoxp-test-token",
            scope: "users:read,chat:write",
          },
        });
      });
      server.use(handler);

      const result = await exchangeSlackCode(
        "client-id",
        "client-secret",
        "test-code",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("xoxp-test-token");
      expect(result.userId).toBe("U-test");
      expect(result.scopes).toEqual(["users:read", "chat:write"]);
    });

    it("throws when Slack returns ok=false", async () => {
      const handler = http.post("https://slack.com/api/oauth.v2.access", () => {
        return HttpResponse.json({
          ok: false,
          error: "invalid_code",
        });
      });
      server.use(handler);

      await expect(
        exchangeSlackCode(
          "client-id",
          "client-secret",
          "bad-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("invalid_code");
    });

    it("throws when no user access token in response", async () => {
      const handler = http.post("https://slack.com/api/oauth.v2.access", () => {
        return HttpResponse.json({
          ok: true,
          authed_user: { id: "U-test" },
        });
      });
      server.use(handler);

      await expect(
        exchangeSlackCode(
          "client-id",
          "client-secret",
          "test-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow("No user access token");
    });
  });

  describe("fetchSlackUserInfo", () => {
    it("fetches user info successfully", async () => {
      const handler = http.get("https://slack.com/api/users.info", () => {
        return HttpResponse.json({
          ok: true,
          user: {
            id: "U-test",
            name: "testuser",
            real_name: "Test User",
            profile: { email: "test@example.com" },
          },
        });
      });
      server.use(handler);

      const result = await fetchSlackUserInfo("U-test", "xoxp-token");

      expect(result.id).toBe("U-test");
      expect(result.username).toBe("Test User");
      expect(result.email).toBe("test@example.com");
    });

    it("throws when Slack returns ok=false", async () => {
      const handler = http.get("https://slack.com/api/users.info", () => {
        return HttpResponse.json({
          ok: false,
          error: "user_not_found",
        });
      });
      server.use(handler);

      await expect(
        fetchSlackUserInfo("U-unknown", "xoxp-token"),
      ).rejects.toThrow("user_not_found");
    });
  });

  describe("revokeSlackToken", () => {
    it("revokes token successfully", async () => {
      const handler = http.post("https://slack.com/api/auth.revoke", () => {
        return HttpResponse.json({ ok: true, revoked: true });
      });
      server.use(handler);

      await expect(
        revokeSlackToken("client-id", "client-secret", "xoxp-token"),
      ).resolves.toBeUndefined();
    });

    it("throws when revocation fails", async () => {
      const handler = http.post("https://slack.com/api/auth.revoke", () => {
        return HttpResponse.json({ ok: false, error: "token_revoked" });
      });
      server.use(handler);

      await expect(
        revokeSlackToken("client-id", "client-secret", "xoxp-token"),
      ).rejects.toThrow("token_revoked");
    });
  });

  describe("getSlackSecretName", () => {
    it("returns the expected secret name", () => {
      expect(getSlackSecretName()).toBe("SLACK_ACCESS_TOKEN");
    });
  });
});
