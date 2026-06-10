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
const DEVICE_AUTHORIZATION_ROUTE = "/api/test/oauth-provider/device/code";
const TOKEN_ROUTE = "/api/test/oauth-provider/token";
const USERINFO_ROUTE = "/api/test/oauth-provider/userinfo";
const ECHO_ROUTE = "/api/test/oauth-provider/echo";

interface ErrorBody {
  readonly error: string;
  readonly error_description?: string;
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

interface TokenBody {
  readonly access_token: string;
  readonly refresh_token?: string | null;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: string;
}

interface DeviceAuthBody {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
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

function tokenRequest(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
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

describe("/api/test/oauth-provider/*", () => {
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

  it("returns 404 for the token route in production", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(
      TOKEN_ROUTE,
      tokenRequest({ grant_type: "authorization_code" }),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns 404 for the device authorization route in production", async () => {
    mockEnv("ENV", "production");

    const response = await requestApp(
      DEVICE_AUTHORIZATION_ROUTE,
      tokenRequest({
        client_id: "test-oauth-device-client",
        scope: "read",
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
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
    const allowedViaInternalProxyHeader = await requestApp(
      validAuthorizePath(),
      {
        headers: { "x-vm0-test-endpoint-bypass": "preview-secret" },
      },
    );

    expect(denied.status).toBe(404);
    expect(allowed.status).toBe(302);
    expect(allowedViaInternalProxyHeader.status).toBe(302);
  });

  it("requires the preview bypass secret for userinfo when ENV is preview", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    mockNow(new Date("2026-05-12T00:00:00.000Z"));
    const token = mintAccessToken(3600);

    const denied = await requestApp(USERINFO_ROUTE, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-vercel-protection-bypass": "wrong-secret",
      },
    });
    const allowed = await requestApp(USERINFO_ROUTE, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
    });

    expect(denied.status).toBe(404);
    await expect(denied.text()).resolves.toBe("Not found");
    expect(allowed.status).toBe(200);
    await expect(readJson<UserinfoBody>(allowed)).resolves.toStrictEqual({
      id: "testoauth-user-1",
      username: "testoauth",
      email: "testoauth@example.com",
    });
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

  describe("device authorization", () => {
    it("starts a device authorization session", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        DEVICE_AUTHORIZATION_ROUTE,
        tokenRequest({
          client_id: "test-oauth-device-client",
          scope: "read",
        }),
      );

      expect(response.status).toBe(200);
      await expect(readJson<DeviceAuthBody>(response)).resolves.toStrictEqual({
        device_code: "test-device:test-oauth-device-client:read",
        user_code: "TEST-DEVICE",
        verification_uri: "https://oauth-device.test/device",
        verification_uri_complete:
          "https://oauth-device.test/device?user_code=TEST-DEVICE",
        expires_in: 600,
        interval: 0,
      });
    });

    it("starts a device authorization session for the API device client", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        DEVICE_AUTHORIZATION_ROUTE,
        tokenRequest({
          client_id: "test-oauth-device-api-client",
          scope: "read",
          mode: "live",
        }),
      );

      expect(response.status).toBe(200);
      await expect(readJson<DeviceAuthBody>(response)).resolves.toStrictEqual({
        device_code: "test-device:test-oauth-device-api-client:read:live",
        user_code: "TEST-DEVICE",
        verification_uri: "https://oauth-device.test/device",
        verification_uri_complete:
          "https://oauth-device.test/device?user_code=TEST-DEVICE",
        expires_in: 600,
        interval: 0,
      });
    });

    it("requires the preview bypass secret", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

      const denied = await requestApp(
        DEVICE_AUTHORIZATION_ROUTE,
        tokenRequest({
          client_id: "test-oauth-device-client",
          scope: "read",
        }),
      );
      const allowed = await requestApp(DEVICE_AUTHORIZATION_ROUTE, {
        ...tokenRequest({
          client_id: "test-oauth-device-client",
          scope: "read",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-vm0-test-endpoint-bypass": "preview-secret",
        },
      });

      expect(denied.status).toBe(404);
      await expect(denied.text()).resolves.toBe("Not found");
      expect(allowed.status).toBe(200);
    });

    it("rejects requests without a form body", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(DEVICE_AUTHORIZATION_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_request",
        error_description: "expected form body",
      });
    });

    it("rejects an invalid client_id", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        DEVICE_AUTHORIZATION_ROUTE,
        tokenRequest({
          client_id: "wrong",
          scope: "read",
        }),
      );

      expect(response.status).toBe(401);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_client",
      });
    });
  });

  describe("token authorization_code", () => {
    it("exchanges a valid authorization code for tokens", async () => {
      mockEnv("ENV", "development");
      mockNow(new Date("2026-05-12T00:00:00.000Z"));

      const authorize = await requestApp(validAuthorizePath());
      const location = authorize.headers.get("location");
      expect(location).not.toBeNull();
      const code = new URL(location ?? "").searchParams.get("code");
      expect(code).not.toBeNull();

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: code ?? "",
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<TokenBody>(response);
      expect(body.access_token).toMatch(/^testoauth_at_/);
      expect(body.refresh_token).toMatch(/^testoauth_rt_/);
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(3600);
      expect(body.scope).toBe("read");
    });

    it("rejects requests without a form body", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(TOKEN_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_request",
        error_description: "expected form body",
      });
    });

    it("rejects invalid client credentials", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "wrong",
          client_secret: "wrong",
          code: "testoauth_code_success_abc",
        }),
      );

      expect(response.status).toBe(401);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_client",
      });
    });

    it("rejects a missing authorization code", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
        }),
      );

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_request",
        error_description: "code required",
      });
    });

    it("rejects an invalid authorization code", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: "testoauth_code_unknown_abc",
        }),
      );

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_grant",
        error_description: "malformed or unknown code",
      });
    });

    it("returns 401 for a revoked authorization code", async () => {
      mockEnv("ENV", "development");

      const authorize = await requestApp(
        validAuthorizePath({ scenario: "revoked" }),
      );
      const location = authorize.headers.get("location");
      expect(location).not.toBeNull();
      const code = new URL(location ?? "").searchParams.get("code");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: code ?? "",
        }),
      );

      expect(response.status).toBe(401);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_grant",
        error_description: "token revoked",
      });
    });

    it("returns an immediate-expiry token for expired-access scenario", async () => {
      mockEnv("ENV", "development");

      const authorize = await requestApp(
        validAuthorizePath({ scenario: "expired-access" }),
      );
      const location = authorize.headers.get("location");
      expect(location).not.toBeNull();
      const code = new URL(location ?? "").searchParams.get("code");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: code ?? "",
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<TokenBody>(response);
      expect(body.expires_in).toBe(0);
    });

    it("returns a short-lived token for short-lived-access scenario", async () => {
      mockEnv("ENV", "development");

      const authorize = await requestApp(
        validAuthorizePath({ scenario: "short-lived-access" }),
      );
      const location = authorize.headers.get("location");
      expect(location).not.toBeNull();
      const code = new URL(location ?? "").searchParams.get("code");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: code ?? "",
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<TokenBody>(response);
      expect(body.expires_in).toBe(55);
    });
  });

  describe("token refresh_token", () => {
    it("mints a fresh access token for a valid refresh token", async () => {
      mockEnv("ENV", "development");

      const authorize = await requestApp(validAuthorizePath());
      const location = authorize.headers.get("location");
      expect(location).not.toBeNull();
      const code = new URL(location ?? "").searchParams.get("code");
      const firstResponse = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: code ?? "",
        }),
      );
      const first = await readJson<TokenBody>(firstResponse);
      const refreshToken = first.refresh_token;
      if (!refreshToken) {
        throw new Error("Expected refresh token");
      }

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: refreshToken,
        }),
      );

      expect(response.status).toBe(200);
      const refreshed = await readJson<TokenBody>(response);
      expect(refreshed.access_token).toMatch(/^testoauth_at_/);
      expect(refreshed.access_token).not.toBe(first.access_token);
    });

    it("allows synthetic preview refresh grants without a bypass header", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: "testoauth_rt_success_valid",
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<TokenBody>(response);
      expect(body.access_token).toMatch(/^testoauth_at_/);
      expect(body.refresh_token).toMatch(/^testoauth_rt_success_/);
    });

    it("hides non-refresh preview token grants without a bypass header", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "authorization_code",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          code: "testoauth_code_success_abc",
        }),
      );

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not found");
    });

    it("rejects an invalid-refresh scenario token", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: "testoauth_rt_invalid-refresh_abc",
        }),
      );

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_grant",
        error_description: "refresh token rejected",
      });
    });

    it("rejects a malformed prefixed refresh token", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: "testoauth_rt_unknown_abc",
        }),
      );

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "invalid_grant",
        error_description: "malformed or unknown refresh token scenario",
      });
    });

    it("accepts arbitrary opaque refresh tokens as success", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "refresh_token",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
          refresh_token: "arbitrary-opaque-token",
        }),
      );

      expect(response.status).toBe(200);
      const body = await readJson<TokenBody>(response);
      expect(body.access_token).toMatch(/^testoauth_at_/);
    });

    it("rejects an unsupported grant type", async () => {
      mockEnv("ENV", "development");

      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "password",
          client_id: "test-oauth-client",
          client_secret: "test-oauth-secret",
        }),
      );

      expect(response.status).toBe(400);
      await expect(readJson<ErrorBody>(response)).resolves.toStrictEqual({
        error: "unsupported_grant_type",
      });
    });
  });

  describe("token device_code", () => {
    it("exchanges a valid device code for an access token", async () => {
      mockEnv("ENV", "development");

      const device = await requestApp(
        DEVICE_AUTHORIZATION_ROUTE,
        tokenRequest({
          client_id: "test-oauth-device-client",
          scope: "read",
        }),
      );
      const deviceBody = await readJson<DeviceAuthBody>(device);
      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "test-oauth-device-client",
          device_code: deviceBody.device_code,
        }),
      );

      expect(response.status).toBe(200);
      await expect(readJson<TokenBody>(response)).resolves.toStrictEqual({
        access_token:
          "test-device-access:test-oauth-device-client:test-device:test-oauth-device-client:read",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });
    });

    it("exchanges an API client device code for an access token", async () => {
      mockEnv("ENV", "development");

      const device = await requestApp(
        DEVICE_AUTHORIZATION_ROUTE,
        tokenRequest({
          client_id: "test-oauth-device-api-client",
          scope: "read",
          mode: "test",
        }),
      );
      const deviceBody = await readJson<DeviceAuthBody>(device);
      const response = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "test-oauth-device-api-client",
          device_code: deviceBody.device_code,
        }),
      );

      expect(response.status).toBe(200);
      await expect(readJson<TokenBody>(response)).resolves.toStrictEqual({
        access_token:
          "test-device-access:test-oauth-device-api-client:test-device:test-oauth-device-api-client:read:test",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });
    });

    it("returns standard pending and terminal device-code errors", async () => {
      mockEnv("ENV", "development");

      const pending = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "test-oauth-device-client",
          device_code: "pending",
        }),
      );
      const denied = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "test-oauth-device-client",
          device_code: "denied",
        }),
      );

      expect(pending.status).toBe(400);
      await expect(readJson<ErrorBody>(pending)).resolves.toStrictEqual({
        error: "authorization_pending",
      });
      expect(denied.status).toBe(400);
      await expect(readJson<ErrorBody>(denied)).resolves.toStrictEqual({
        error: "access_denied",
        error_description: "User denied the device authorization request",
      });
    });

    it("rejects invalid device grant requests", async () => {
      mockEnv("ENV", "development");

      const invalidClient = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "wrong",
          device_code: "test-device:test-oauth-device-client:read",
        }),
      );
      const missingDeviceCode = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "test-oauth-device-client",
        }),
      );
      const unknownDeviceCode = await requestApp(
        TOKEN_ROUTE,
        tokenRequest({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "test-oauth-device-client",
          device_code: "not-issued",
        }),
      );

      expect(invalidClient.status).toBe(401);
      await expect(readJson<ErrorBody>(invalidClient)).resolves.toStrictEqual({
        error: "invalid_client",
      });
      expect(missingDeviceCode.status).toBe(400);
      await expect(
        readJson<ErrorBody>(missingDeviceCode),
      ).resolves.toStrictEqual({
        error: "invalid_request",
        error_description: "device_code required",
      });
      expect(unknownDeviceCode.status).toBe(400);
      await expect(
        readJson<ErrorBody>(unknownDeviceCode),
      ).resolves.toStrictEqual({
        error: "invalid_grant",
        error_description: "unknown device_code",
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
    it("allows preview echo when the firewall injects a test-oauth Bearer token", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
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

    it("hides preview echo without bypass or a test-oauth Bearer token", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

      const missingToken = await requestApp(ECHO_ROUTE);
      const invalidToken = await requestApp(ECHO_ROUTE, {
        headers: bearerHeaders("not-a-testoauth-token"),
      });

      expect(missingToken.status).toBe(404);
      await expect(missingToken.text()).resolves.toBe("Not found");
      expect(invalidToken.status).toBe(404);
      await expect(invalidToken.text()).resolves.toBe("Not found");
    });

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
