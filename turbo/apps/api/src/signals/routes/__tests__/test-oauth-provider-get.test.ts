import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import {
  mintAccessToken,
  mintExpiredAccessToken,
} from "../test-oauth-provider-helpers";

const context = testContext();
const AUTHORIZE_ROUTE = "/api/test/oauth-provider/authorize";
const USERINFO_ROUTE = "/api/test/oauth-provider/userinfo";
const ECHO_ROUTE = "/api/test/oauth-provider/echo";

interface ErrorBody {
  readonly error: string;
}

interface EchoBody {
  readonly authorization: string;
  readonly receivedAt: string;
}

interface UserinfoBody {
  readonly email: string;
  readonly id: string;
  readonly username: string;
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

function makeAuthorizePath(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${AUTHORIZE_ROUTE}?${search.toString()}`;
}

function validAuthorizePath(overrides: Record<string, string> = {}): string {
  return makeAuthorizePath({
    client_id: "test-oauth-client",
    redirect_uri: "http://localhost:3000/api/connectors/test-oauth/callback",
    response_type: "code",
    state: "state-123",
    ...overrides,
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function bearerHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

afterEach(() => {
  clearMockNow();
});

describe("GET /api/test/oauth-provider/*", () => {
  it("returns 404 for all scoped GET routes in production", async () => {
    mockEnv("ENV", "production");

    const authorize = await requestApp(validAuthorizePath());
    const userinfo = await requestApp(USERINFO_ROUTE);
    const echo = await requestApp(ECHO_ROUTE);

    expect(authorize.status).toBe(404);
    await expect(authorize.text()).resolves.toBe("Not found");
    expect(userinfo.status).toBe(404);
    await expect(userinfo.text()).resolves.toBe("Not found");
    expect(echo.status).toBe(404);
    await expect(echo.text()).resolves.toBe("Not found");
  });

  it("requires the preview bypass secret when ENV is preview", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const denied = await requestApp(validAuthorizePath(), {
      headers: { "x-vercel-protection-bypass": "wrong-secret" },
    });
    const allowed = await requestApp(validAuthorizePath(), {
      headers: { "x-vercel-protection-bypass": "preview-secret" },
    });

    expect(denied.status).toBe(404);
    expect(allowed.status).toBe(302);
  });

  describe("authorize", () => {
    it("returns 302 with code and state appended to redirect_uri", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(validAuthorizePath());

      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      const redirect = new URL(location ?? "");
      expect(redirect.origin).toBe("http://localhost:3000");
      expect(redirect.pathname).toBe("/api/connectors/test-oauth/callback");
      expect(redirect.searchParams.get("code")).toMatch(/^testoauth_code_/);
      expect(redirect.searchParams.get("state")).toBe("state-123");
    });

    it("rejects an invalid client_id", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        validAuthorizePath({ client_id: "wrong" }),
      );

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_client",
      });
    });

    it("rejects missing required query params", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        makeAuthorizePath({ client_id: "test-oauth-client" }),
      );

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "client_id, redirect_uri, and state are required",
      });
    });

    it("rejects an invalid scenario value", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        validAuthorizePath({ scenario: "not-a-real-scenario" }),
      );

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_scenario",
      });
    });
  });

  describe("userinfo", () => {
    it("returns deterministic user info with a valid Bearer token", async () => {
      mockEnv("ENV", "development");
      mockNow(new Date("2026-05-12T00:00:00.000Z"));
      const token = mintAccessToken(3600);

      const response = await requestApp(USERINFO_ROUTE, {
        headers: bearerHeaders(token),
      });

      expect(response.status).toBe(200);
      await expect(readJson<UserinfoBody>(response)).resolves.toStrictEqual({
        id: "testoauth-user-1",
        username: "testoauth",
        email: "testoauth@example.com",
      });
    });

    it("returns 401 without a Bearer token", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(USERINFO_ROUTE);

      expect(response.status).toBe(401);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_token",
      });
    });

    it("returns 401 with a non-test token", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(USERINFO_ROUTE, {
        headers: bearerHeaders("not-a-testoauth-token"),
      });

      expect(response.status).toBe(401);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_token",
      });
    });

    it("returns 401 for an expired access token", async () => {
      mockEnv("ENV", "development");
      mockNow(new Date("2026-05-12T00:00:00.000Z"));
      const token = mintExpiredAccessToken();

      const response = await requestApp(USERINFO_ROUTE, {
        headers: bearerHeaders(token),
      });

      expect(response.status).toBe(401);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "expired_token",
      });
    });
  });

  describe("echo", () => {
    it("echoes a valid Bearer token with deterministic receivedAt", async () => {
      mockEnv("ENV", "development");
      mockNow(new Date("2026-05-12T00:00:00.000Z"));
      const token = mintAccessToken(3600);

      const response = await requestApp(ECHO_ROUTE, {
        headers: bearerHeaders(token),
      });

      expect(response.status).toBe(200);
      await expect(readJson<EchoBody>(response)).resolves.toStrictEqual({
        authorization: `Bearer ${token}`,
        receivedAt: "2026-05-12T00:00:00.000Z",
      });
    });

    it("returns 401 without a Bearer token", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(ECHO_ROUTE);

      expect(response.status).toBe(401);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_token",
      });
    });

    it("returns 401 for an expired access token", async () => {
      mockEnv("ENV", "development");
      mockNow(new Date("2026-05-12T00:00:00.000Z"));
      const token = mintExpiredAccessToken();

      const response = await requestApp(ECHO_ROUTE, {
        headers: bearerHeaders(token),
      });

      expect(response.status).toBe(401);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "expired_token",
      });
    });
  });
});
