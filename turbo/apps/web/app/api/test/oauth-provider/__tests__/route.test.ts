import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as tokenPost } from "../token/route";
import { GET as userinfoGet } from "../userinfo/route";
import { reloadEnv } from "../../../../../src/env";
import {
  mintAccessToken,
  mintAuthCode,
  mintExpiredAccessToken,
  type TestOAuthScenario,
} from "../_lib/token-helpers";

const APP_URL = "http://localhost:3000";

function makeTokenRequest(body: Record<string, string>): Request {
  return new Request(`${APP_URL}/api/test/oauth-provider/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

function makeAuthCode(scenario: TestOAuthScenario = "success"): string {
  return mintAuthCode(scenario);
}

describe("/api/test/oauth-provider", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "");
    reloadEnv();
  });

  describe("production guard", () => {
    it("token returns 404 in production", async () => {
      vi.stubEnv("VERCEL_ENV", "production");
      reloadEnv();
      const response = await tokenPost(
        makeTokenRequest({ grant_type: "authorization_code" }),
      );
      expect(response.status).toBe(404);
    });

    it("userinfo returns 404 in production", async () => {
      vi.stubEnv("VERCEL_ENV", "production");
      reloadEnv();
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("token — authorization_code", () => {
    it("exchanges code for tokens", async () => {
      const response = await tokenPost(
        makeTokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: makeAuthCode(),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.access_token).toMatch(/^testoauth_at_/);
      expect(body.refresh_token).toMatch(/^testoauth_rt_/);
      expect(body.expires_in).toBe(3600);
      expect(body.token_type).toBe("Bearer");
      expect(body.scope).toBe("read");
    });

    it("rejects an invalid code", async () => {
      const response = await tokenPost(
        makeTokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: "testoauth_code_nope",
        }),
      );
      expect(response.status).toBe(400);
    });

    it("revoked scenario returns 401", async () => {
      const response = await tokenPost(
        makeTokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: makeAuthCode("revoked"),
        }),
      );
      expect(response.status).toBe(401);
    });

    it("expired-access scenario returns expires_in=0", async () => {
      const response = await tokenPost(
        makeTokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: makeAuthCode("expired-access"),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.expires_in).toBe(0);
    });

    it("rejects invalid client credentials", async () => {
      const response = await tokenPost(
        makeTokenRequest({
          grant_type: "authorization_code",
          client_id: "wrong",
          client_secret: "wrong",
          code: "testoauth_code_doesnt-matter",
        }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid_client" });
    });
  });

  describe("token — refresh_token", () => {
    it("mints a fresh access token for a valid refresh token", async () => {
      const firstResponse = await tokenPost(
        makeTokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: makeAuthCode(),
        }),
      );
      const first = await firstResponse.json();

      const refreshResponse = await tokenPost(
        makeTokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: first.refresh_token,
        }),
      );
      expect(refreshResponse.status).toBe(200);
      const refreshed = await refreshResponse.json();
      expect(refreshed.access_token).toMatch(/^testoauth_at_/);
      expect(refreshed.access_token).not.toBe(first.access_token);
    });

    it("invalid-refresh scenario returns 400 invalid_grant", async () => {
      const firstResponse = await tokenPost(
        makeTokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: makeAuthCode("invalid-refresh"),
        }),
      );
      const first = await firstResponse.json();

      const refreshResponse = await tokenPost(
        makeTokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: first.refresh_token,
        }),
      );
      expect(refreshResponse.status).toBe(400);
      const body = await refreshResponse.json();
      expect(body.error).toBe("invalid_grant");
    });

    it("rejects testoauth_rt_* with unknown scenario tag", async () => {
      // Prefix says "this is one of ours" but the scenario segment isn't one
      // of the four valid values → reject as malformed. Guards against
      // silently falling through to success when a test typos the scenario.
      const response = await tokenPost(
        makeTokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: "testoauth_rt_unknown_abc",
        }),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_grant");
    });

    it("accepts refresh tokens without our prefix as success", async () => {
      // Real OAuth 2 providers don't require refresh tokens to carry
      // structure; preserve that tolerance so tests seeding arbitrary
      // tokens (e.g. from external fixtures) still succeed.
      const response = await tokenPost(
        makeTokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: "arbitrary-opaque-token",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("rejects unsupported grant_type", async () => {
      const response = await tokenPost(
        makeTokenRequest({
          grant_type: "password",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "unsupported_grant_type",
      });
    });
  });

  describe("userinfo", () => {
    it("returns user payload with valid Bearer token", async () => {
      const token = mintAccessToken(3600);
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe("testoauth-user-1");
    });

    it("returns 401 without Bearer token", async () => {
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`),
      );
      expect(response.status).toBe(401);
    });

    it("returns 401 with non-test token", async () => {
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`, {
          headers: { authorization: "Bearer not-a-testoauth-token" },
        }),
      );
      expect(response.status).toBe(401);
    });

    it("returns 401 for expired access token", async () => {
      const token = mintExpiredAccessToken();
      const response = await userinfoGet(
        new Request(`${APP_URL}/api/test/oauth-provider/userinfo`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "expired_token" });
    });
  });
});
