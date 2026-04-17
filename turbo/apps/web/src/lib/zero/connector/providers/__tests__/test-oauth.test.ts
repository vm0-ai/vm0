import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { http } from "../../../../../__tests__/msw";
import { testContext } from "../../../../../__tests__/test-helpers";
import {
  buildTestOAuthAuthorizationUrl,
  exchangeTestOAuthCode,
  fetchTestOAuthUserInfo,
  refreshTestOAuthToken,
  TEST_OAUTH_ACCESS_SECRET_NAME,
  TEST_OAUTH_REFRESH_SECRET_NAME,
} from "../test-oauth";

const context = testContext();

describe("connector/providers/test-oauth", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("buildTestOAuthAuthorizationUrl", () => {
    it("builds URL with client_id, redirect_uri, state, and response_type", () => {
      const url = buildTestOAuthAuthorizationUrl(
        "client-abc",
        "https://example.com/callback",
        "state-xyz",
      );

      expect(url).toContain("/api/test/oauth-provider/authorize");
      expect(url).toContain("client_id=client-abc");
      expect(url).toContain(
        `redirect_uri=${encodeURIComponent("https://example.com/callback")}`,
      );
      expect(url).toContain("state=state-xyz");
      expect(url).toContain("response_type=code");
    });
  });

  describe("exchangeTestOAuthCode", () => {
    it("posts authorization_code grant and parses token response", async () => {
      const { handler, mocked } = http.post(
        /oauth-provider\/token$/,
        async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("code")).toBe("code-123");
          expect(body.get("client_id")).toBe("client-id");
          expect(body.get("client_secret")).toBe("client-secret");
          return HttpResponse.json({
            access_token: "testoauth_at_abc",
            refresh_token: "testoauth_rt_abc",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "read",
          });
        },
      );
      server.use(handler);

      const result = await exchangeTestOAuthCode(
        "client-id",
        "client-secret",
        "code-123",
        "https://example.com/callback",
      );

      expect(result.accessToken).toBe("testoauth_at_abc");
      expect(result.refreshToken).toBe("testoauth_rt_abc");
      expect(result.expiresIn).toBe(3600);
      expect(result.scopes).toEqual(["read"]);
      expect(mocked).toHaveBeenCalledOnce();
    });

    it("throws when token endpoint returns 4xx", async () => {
      const { handler } = http.post(/oauth-provider\/token$/, () => {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      });
      server.use(handler);

      await expect(
        exchangeTestOAuthCode(
          "client-id",
          "client-secret",
          "bad-code",
          "https://example.com/callback",
        ),
      ).rejects.toThrow();
    });
  });

  describe("refreshTestOAuthToken", () => {
    it("posts refresh_token grant and parses new token", async () => {
      const { handler, mocked } = http.post(
        /oauth-provider\/token$/,
        async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          expect(body.get("grant_type")).toBe("refresh_token");
          expect(body.get("refresh_token")).toBe("testoauth_rt_old");
          return HttpResponse.json({
            access_token: "testoauth_at_new",
            refresh_token: "testoauth_rt_new",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "read",
          });
        },
      );
      server.use(handler);

      const result = await refreshTestOAuthToken(
        "client-id",
        "client-secret",
        "testoauth_rt_old",
      );

      expect(result.accessToken).toBe("testoauth_at_new");
      expect(result.refreshToken).toBe("testoauth_rt_new");
      expect(mocked).toHaveBeenCalledOnce();
    });

    it("throws on invalid_grant", async () => {
      const { handler } = http.post(/oauth-provider\/token$/, () => {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      });
      server.use(handler);

      await expect(
        refreshTestOAuthToken("client-id", "client-secret", "bad-refresh"),
      ).rejects.toThrow();
    });
  });

  describe("fetchTestOAuthUserInfo", () => {
    it("fetches userinfo with Bearer token", async () => {
      const { handler, mocked } = http.get(
        /oauth-provider\/userinfo$/,
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer testoauth_at_abc",
          );
          return HttpResponse.json({
            id: "testoauth-user-1",
            username: "testoauth",
            email: "testoauth@example.com",
          });
        },
      );
      server.use(handler);

      const result = await fetchTestOAuthUserInfo("testoauth_at_abc");
      expect(result.id).toBe("testoauth-user-1");
      expect(result.username).toBe("testoauth");
      expect(result.email).toBe("testoauth@example.com");
      expect(mocked).toHaveBeenCalledOnce();
    });

    it("throws when userinfo returns 401", async () => {
      const { handler } = http.get(/oauth-provider\/userinfo$/, () => {
        return HttpResponse.json({ error: "invalid_token" }, { status: 401 });
      });
      server.use(handler);

      await expect(fetchTestOAuthUserInfo("bad-token")).rejects.toThrow(
        /userinfo failed: 401/,
      );
    });
  });

  describe("secret name helpers", () => {
    it("exposes stable access and refresh secret names", () => {
      expect(TEST_OAUTH_ACCESS_SECRET_NAME).toBe("TEST_OAUTH_ACCESS_TOKEN");
      expect(TEST_OAUTH_REFRESH_SECRET_NAME).toBe("TEST_OAUTH_REFRESH_TOKEN");
    });
  });
});
