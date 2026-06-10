import { afterEach, describe, expect, it } from "vitest";

import { testOAuthProviderDeviceAuthResponseSchema } from "@vm0/api-contracts/contracts/test-oauth-provider-device-auth";
import { testOAuthProviderEchoContract } from "@vm0/api-contracts/contracts/test-oauth-provider-echo";
import { testOAuthProviderTokenResponseSchema } from "@vm0/api-contracts/contracts/test-oauth-provider-token";
import { testOAuthProviderUserinfoContract } from "@vm0/api-contracts/contracts/test-oauth-provider-userinfo";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  mintAccessToken,
  mintExpiredAccessToken,
} from "../test-oauth-provider-helpers";

const context = testContext();
const AUTHORIZE_ROUTE = "/api/test/oauth-provider/authorize";
const DEVICE_AUTHORIZATION_ROUTE = "/api/test/oauth-provider/device/code";
const TOKEN_ROUTE = "/api/test/oauth-provider/token";

interface AuthorizeParams {
  readonly client_id?: string;
  readonly redirect_uri?: string;
  readonly response_type?: string;
  readonly scenario?: string;
  readonly scope?: string;
  readonly state?: string;
}

function userinfoClient() {
  return setupApp({ context })(testOAuthProviderUserinfoContract);
}

function echoClient() {
  return setupApp({ context })(testOAuthProviderEchoContract);
}

function formBody(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

function formHeaders(): HeadersInit {
  return { "content-type": "application/x-www-form-urlencoded" };
}

function bearerHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function authorizeParams(overrides: AuthorizeParams = {}): AuthorizeParams {
  return {
    client_id: "test-oauth-client",
    redirect_uri: "http://localhost:3000/api/connectors/test-oauth/callback",
    response_type: "code",
    state: "state-123",
    ...overrides,
  };
}

function authorizePath(params: AuthorizeParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }
  return `${AUTHORIZE_ROUTE}?${search.toString()}`;
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(path, init);
}

function authorize(
  params: AuthorizeParams = authorizeParams(),
  headers: HeadersInit = {},
): Promise<Response> {
  return rawRequest(authorizePath(params), { headers });
}

function tokenGrant(body: Record<string, string>) {
  return rawRequest(TOKEN_ROUTE, {
    method: "POST",
    headers: formHeaders(),
    body: formBody(body),
  });
}

function tokenGrantWithHeaders(
  body: Record<string, string>,
  headers: HeadersInit,
) {
  return rawRequest(TOKEN_ROUTE, {
    method: "POST",
    headers,
    body: formBody(body),
  });
}

function deviceAuthorization(body: Record<string, string>) {
  return rawRequest(DEVICE_AUTHORIZATION_ROUTE, {
    method: "POST",
    headers: formHeaders(),
    body: formBody(body),
  });
}

function deviceAuthorizationWithHeaders(
  body: Record<string, string>,
  headers: HeadersInit,
) {
  return rawRequest(DEVICE_AUTHORIZATION_ROUTE, {
    method: "POST",
    headers,
    body: formBody(body),
  });
}

function expectStatus(response: Response, status: number): void {
  expect(response.status).toBe(status);
}

async function readTokenBody(response: Response) {
  return testOAuthProviderTokenResponseSchema.parse(await response.json());
}

async function readDeviceAuthBody(response: Response) {
  return testOAuthProviderDeviceAuthResponseSchema.parse(await response.json());
}

async function expectRawJson(
  response: Response,
  expected: unknown,
): Promise<void> {
  await expect(response.json()).resolves.toStrictEqual(expected);
}

async function expectRawText(
  response: Response,
  expected: string,
): Promise<void> {
  await expect(response.text()).resolves.toBe(expected);
}

function requireRedirect(response: Response): URL {
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error("Expected redirect location header");
  }
  return new URL(location);
}

function requireCode(redirect: URL): string {
  const code = redirect.searchParams.get("code");
  if (code === null) {
    throw new Error("Expected authorization code in redirect");
  }
  return code;
}

afterEach(() => {
  clearMockNow();
});

describe("/api/test/oauth-provider/* BDD", () => {
  it("hides test OAuth endpoints outside development and enforces preview bypass rules", async () => {
    mockEnv("ENV", "production");

    const hiddenAuthorize = await authorize();
    const hiddenUserinfo = await accept(userinfoClient().userinfo(), [404]);
    const hiddenEcho = await accept(echoClient().echo(), [404]);
    const hiddenToken = await tokenGrant({ grant_type: "authorization_code" });
    const hiddenDevice = await deviceAuthorization({
      client_id: "test-oauth-device-client",
      scope: "read",
    });

    expect(hiddenAuthorize.status).toBe(404);
    expect(hiddenToken.status).toBe(404);
    expect(hiddenDevice.status).toBe(404);
    await expectRawText(hiddenAuthorize, "Not found");
    await expectRawText(hiddenToken, "Not found");
    await expectRawText(hiddenDevice, "Not found");
    expect(hiddenUserinfo.body).toBe("Not found");
    expect(hiddenEcho.body).toBe("Not found");

    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const deniedAuthorize = await authorize(authorizeParams(), {
      "x-vercel-protection-bypass": "wrong-secret",
    });
    const allowedAuthorize = await authorize(authorizeParams(), {
      "x-vercel-protection-bypass": "preview-secret",
    });
    const allowedViaProxy = await authorize(authorizeParams(), {
      "x-vm0-test-endpoint-bypass": "preview-secret",
    });

    expect(deniedAuthorize.status).toBe(404);
    expect(allowedAuthorize.status).toBe(302);
    expect(allowedViaProxy.status).toBe(302);

    mockNow(new Date("2026-05-12T00:00:00.000Z"));
    const token = mintAccessToken(3600);
    const deniedUserinfo = await accept(
      userinfoClient().userinfo({
        extraHeaders: {
          authorization: `Bearer ${token}`,
          "x-vercel-protection-bypass": "wrong-secret",
        },
      }),
      [404],
    );
    const allowedUserinfo = await accept(
      userinfoClient().userinfo({
        extraHeaders: {
          authorization: `Bearer ${token}`,
          "x-vm0-test-endpoint-bypass": "preview-secret",
        },
      }),
      [200],
    );

    expect(deniedUserinfo.body).toBe("Not found");
    expect(allowedUserinfo.body).toStrictEqual({
      id: "testoauth-user-1",
      username: "testoauth",
      email: "testoauth@example.com",
    });

    const deniedDevice = await deviceAuthorization({
      client_id: "test-oauth-device-client",
      scope: "read",
    });
    const allowedDevice = await deviceAuthorizationWithHeaders(
      {
        client_id: "test-oauth-device-client",
        scope: "read",
      },
      {
        ...formHeaders(),
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
    );
    const allowedDeviceBody = await readDeviceAuthBody(allowedDevice);

    expect(deniedDevice.status).toBe(404);
    expect(allowedDevice.status).toBe(200);
    await expectRawText(deniedDevice, "Not found");
    expect(allowedDeviceBody.device_code).toBe(
      "test-device:test-oauth-device-client:read",
    );

    const syntheticPreviewRefresh = await tokenGrant({
      grant_type: "refresh_token",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      refresh_token: "testoauth_rt_success_valid",
    });
    const syntheticPreviewRefreshBody = await readTokenBody(
      syntheticPreviewRefresh,
    );
    const hiddenPreviewCodeGrant = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      code: "testoauth_code_success_abc",
    });

    expect(syntheticPreviewRefresh.status).toBe(200);
    expect(hiddenPreviewCodeGrant.status).toBe(404);
    expect(syntheticPreviewRefreshBody.access_token).toMatch(/^testoauth_at_/);
    expect(syntheticPreviewRefreshBody.refresh_token).toMatch(
      /^testoauth_rt_success_/,
    );
    await expectRawText(hiddenPreviewCodeGrant, "Not found");

    const previewEcho = await accept(
      echoClient().echo({ extraHeaders: bearerHeaders(token) }),
      [200],
    );
    const hiddenEchoWithoutToken = await accept(echoClient().echo(), [404]);
    const hiddenEchoWithInvalidToken = await accept(
      echoClient().echo({
        extraHeaders: bearerHeaders("not-a-testoauth-token"),
      }),
      [404],
    );

    expect(previewEcho.body).toStrictEqual({
      authorization: `Bearer ${token}`,
      receivedAt: "2026-05-12T00:00:00.000Z",
    });
    expect(hiddenEchoWithoutToken.body).toBe("Not found");
    expect(hiddenEchoWithInvalidToken.body).toBe("Not found");
  });

  it("authorizes valid clients and rejects malformed authorize requests", async () => {
    mockEnv("ENV", "development");

    const redirect = requireRedirect(await authorize());

    expect(redirect.origin).toBe("http://localhost:3000");
    expect(redirect.pathname).toBe("/api/connectors/test-oauth/callback");
    expect(redirect.searchParams.get("code")).toMatch(/^testoauth_code_/);
    expect(redirect.searchParams.get("state")).toBe("state-123");

    const invalidClient = await authorize(
      authorizeParams({ client_id: "wrong" }),
    );
    const missingParams = await authorize({
      client_id: "test-oauth-client",
    });
    const invalidScenario = await authorize(
      authorizeParams({ scenario: "not-a-real-scenario" }),
    );

    expect(invalidClient.status).toBe(400);
    await expectRawJson(invalidClient, { error: "invalid_client" });
    expect(missingParams.status).toBe(400);
    await expectRawJson(missingParams, {
      error: "client_id, redirect_uri, and state are required",
    });
    expect(invalidScenario.status).toBe(400);
    await expectRawJson(invalidScenario, { error: "invalid_scenario" });
  });

  it("starts device authorization sessions and rejects invalid device authorization requests", async () => {
    mockEnv("ENV", "development");

    const browserDevice = await deviceAuthorization({
      client_id: "test-oauth-device-client",
      scope: "read",
    });
    const apiDevice = await deviceAuthorization({
      client_id: "test-oauth-device-api-client",
      scope: "read",
      mode: "live",
    });
    const browserDeviceBody = await readDeviceAuthBody(browserDevice);
    const apiDeviceBody = await readDeviceAuthBody(apiDevice);

    expectStatus(browserDevice, 200);
    expectStatus(apiDevice, 200);
    expect(browserDeviceBody).toStrictEqual({
      device_code: "test-device:test-oauth-device-client:read",
      user_code: "TEST-DEVICE",
      verification_uri: "https://oauth-device.test/device",
      verification_uri_complete:
        "https://oauth-device.test/device?user_code=TEST-DEVICE",
      expires_in: 600,
      interval: 0,
    });
    expect(apiDeviceBody).toStrictEqual({
      device_code: "test-device:test-oauth-device-api-client:read:live",
      user_code: "TEST-DEVICE",
      verification_uri: "https://oauth-device.test/device",
      verification_uri_complete:
        "https://oauth-device.test/device?user_code=TEST-DEVICE",
      expires_in: 600,
      interval: 0,
    });

    const jsonBody = await deviceAuthorizationWithHeaders(
      {
        client_id: "test-oauth-device-client",
        scope: "read",
      },
      { "content-type": "application/json" },
    );
    const invalidClient = await deviceAuthorization({
      client_id: "wrong",
      scope: "read",
    });

    expectStatus(jsonBody, 400);
    await expectRawJson(jsonBody, {
      error: "invalid_request",
      error_description: "expected form body",
    });
    expectStatus(invalidClient, 401);
    await expectRawJson(invalidClient, { error: "invalid_client" });
  });

  it("exchanges authorization codes and maps authorization-code failures", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-05-12T00:00:00.000Z"));

    const code = requireCode(requireRedirect(await authorize()));
    const exchanged = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      code,
    });
    const exchangedBody = await readTokenBody(exchanged);

    expectStatus(exchanged, 200);
    expect(exchangedBody.access_token).toMatch(/^testoauth_at_/);
    expect(exchangedBody.refresh_token).toMatch(/^testoauth_rt_/);
    expect(exchangedBody.token_type).toBe("Bearer");
    expect(exchangedBody.expires_in).toBe(3600);
    expect(exchangedBody.scope).toBe("read");

    const jsonBody = await tokenGrantWithHeaders(
      { grant_type: "authorization_code" },
      { "content-type": "application/json" },
    );
    const invalidClient = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "wrong",
      client_secret: "wrong",
      code: "testoauth_code_success_abc",
    });
    const missingCode = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
    });
    const unknownCode = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      code: "testoauth_code_unknown_abc",
    });

    expectStatus(jsonBody, 400);
    await expectRawJson(jsonBody, {
      error: "invalid_request",
      error_description: "expected form body",
    });
    expectStatus(invalidClient, 401);
    await expectRawJson(invalidClient, { error: "invalid_client" });
    expectStatus(missingCode, 400);
    await expectRawJson(missingCode, {
      error: "invalid_request",
      error_description: "code required",
    });
    expectStatus(unknownCode, 400);
    await expectRawJson(unknownCode, {
      error: "invalid_grant",
      error_description: "malformed or unknown code",
    });

    const revokedCode = requireCode(
      requireRedirect(
        await authorize(authorizeParams({ scenario: "revoked" })),
      ),
    );
    const revoked = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      code: revokedCode,
    });

    expectStatus(revoked, 401);
    await expectRawJson(revoked, {
      error: "invalid_grant",
      error_description: "token revoked",
    });

    const expiredAccessCode = requireCode(
      requireRedirect(
        await authorize(authorizeParams({ scenario: "expired-access" })),
      ),
    );
    const expiredAccess = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      code: expiredAccessCode,
    });
    const expiredAccessBody = await readTokenBody(expiredAccess);
    const shortLivedCode = requireCode(
      requireRedirect(
        await authorize(authorizeParams({ scenario: "short-lived-access" })),
      ),
    );
    const shortLived = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      code: shortLivedCode,
    });
    const shortLivedBody = await readTokenBody(shortLived);

    expectStatus(expiredAccess, 200);
    expectStatus(shortLived, 200);
    expect(expiredAccessBody.expires_in).toBe(0);
    expect(shortLivedBody.expires_in).toBe(55);
  });

  it("refreshes access tokens and maps refresh-token failures", async () => {
    mockEnv("ENV", "development");

    const code = requireCode(requireRedirect(await authorize()));
    const first = await tokenGrant({
      grant_type: "authorization_code",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      code,
    });
    const firstBody = await readTokenBody(first);
    expectStatus(first, 200);
    const refreshToken = firstBody.refresh_token;
    if (typeof refreshToken !== "string") {
      throw new Error("Expected refresh token");
    }

    const refreshed = await tokenGrant({
      grant_type: "refresh_token",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      refresh_token: refreshToken,
    });
    const refreshedBody = await readTokenBody(refreshed);

    expectStatus(refreshed, 200);
    expect(refreshedBody.access_token).toMatch(/^testoauth_at_/);
    expect(refreshedBody.access_token).not.toBe(firstBody.access_token);

    const invalidRefresh = await tokenGrant({
      grant_type: "refresh_token",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      refresh_token: "testoauth_rt_invalid-refresh_abc",
    });
    const malformedPrefixedRefresh = await tokenGrant({
      grant_type: "refresh_token",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      refresh_token: "testoauth_rt_unknown_abc",
    });
    const opaqueRefresh = await tokenGrant({
      grant_type: "refresh_token",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
      refresh_token: "arbitrary-opaque-token",
    });
    const opaqueRefreshBody = await readTokenBody(opaqueRefresh);
    const unsupportedGrant = await tokenGrant({
      grant_type: "password",
      client_id: "test-oauth-client",
      client_secret: "test-oauth-secret",
    });

    expectStatus(invalidRefresh, 400);
    await expectRawJson(invalidRefresh, {
      error: "invalid_grant",
      error_description: "refresh token rejected",
    });
    expectStatus(malformedPrefixedRefresh, 400);
    await expectRawJson(malformedPrefixedRefresh, {
      error: "invalid_grant",
      error_description: "malformed or unknown refresh token scenario",
    });
    expectStatus(opaqueRefresh, 200);
    expect(opaqueRefreshBody.access_token).toMatch(/^testoauth_at_/);
    expectStatus(unsupportedGrant, 400);
    await expectRawJson(unsupportedGrant, {
      error: "unsupported_grant_type",
    });
  });

  it("exchanges device codes and maps device-token failures", async () => {
    mockEnv("ENV", "development");

    const browserDevice = await deviceAuthorization({
      client_id: "test-oauth-device-client",
      scope: "read",
    });
    const browserDeviceBody = await readDeviceAuthBody(browserDevice);
    const browserToken = await tokenGrant({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-oauth-device-client",
      device_code: browserDeviceBody.device_code,
    });
    const browserTokenBody = await readTokenBody(browserToken);

    expectStatus(browserDevice, 200);
    expectStatus(browserToken, 200);
    expect(browserTokenBody).toStrictEqual({
      access_token:
        "test-device-access:test-oauth-device-client:test-device:test-oauth-device-client:read",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read",
    });

    const apiDevice = await deviceAuthorization({
      client_id: "test-oauth-device-api-client",
      scope: "read",
      mode: "test",
    });
    const apiDeviceBody = await readDeviceAuthBody(apiDevice);
    const apiToken = await tokenGrant({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-oauth-device-api-client",
      device_code: apiDeviceBody.device_code,
    });
    const apiTokenBody = await readTokenBody(apiToken);

    expectStatus(apiDevice, 200);
    expectStatus(apiToken, 200);
    expect(apiTokenBody).toStrictEqual({
      access_token:
        "test-device-access:test-oauth-device-api-client:test-device:test-oauth-device-api-client:read:test",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read",
    });

    const pending = await tokenGrant({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-oauth-device-client",
      device_code: "pending",
    });
    const denied = await tokenGrant({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-oauth-device-client",
      device_code: "denied",
    });
    const invalidClient = await tokenGrant({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "wrong",
      device_code: "test-device:test-oauth-device-client:read",
    });
    const missingDeviceCode = await tokenGrant({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-oauth-device-client",
    });
    const unknownDeviceCode = await tokenGrant({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "test-oauth-device-client",
      device_code: "not-issued",
    });

    expectStatus(pending, 400);
    await expectRawJson(pending, {
      error: "authorization_pending",
    });
    expectStatus(denied, 400);
    await expectRawJson(denied, {
      error: "access_denied",
      error_description: "User denied the device authorization request",
    });
    expectStatus(invalidClient, 401);
    await expectRawJson(invalidClient, { error: "invalid_client" });
    expectStatus(missingDeviceCode, 400);
    await expectRawJson(missingDeviceCode, {
      error: "invalid_request",
      error_description: "device_code required",
    });
    expectStatus(unknownDeviceCode, 400);
    await expectRawJson(unknownDeviceCode, {
      error: "invalid_grant",
      error_description: "unknown device_code",
    });
  });

  it("returns userinfo for valid bearer tokens and rejects invalid userinfo tokens", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-05-12T00:00:00.000Z"));
    const token = mintAccessToken(3600);

    const valid = await accept(
      userinfoClient().userinfo({ extraHeaders: bearerHeaders(token) }),
      [200],
    );
    const missing = await accept(userinfoClient().userinfo(), [401]);
    const invalid = await accept(
      userinfoClient().userinfo({
        extraHeaders: bearerHeaders("not-a-testoauth-token"),
      }),
      [401],
    );
    const expired = await accept(
      userinfoClient().userinfo({
        extraHeaders: bearerHeaders(mintExpiredAccessToken()),
      }),
      [401],
    );

    expect(valid.body).toStrictEqual({
      id: "testoauth-user-1",
      username: "testoauth",
      email: "testoauth@example.com",
    });
    expect(missing.body).toStrictEqual({ error: "invalid_token" });
    expect(invalid.body).toStrictEqual({ error: "invalid_token" });
    expect(expired.body).toStrictEqual({ error: "expired_token" });
  });

  it("echoes valid bearer tokens and rejects invalid echo tokens", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-05-12T00:00:00.000Z"));
    const token = mintAccessToken(3600);

    const valid = await accept(
      echoClient().echo({ extraHeaders: bearerHeaders(token) }),
      [200],
    );
    const missing = await accept(echoClient().echo(), [401]);
    const expired = await accept(
      echoClient().echo({
        extraHeaders: bearerHeaders(mintExpiredAccessToken()),
      }),
      [401],
    );

    expect(valid.body).toStrictEqual({
      authorization: `Bearer ${token}`,
      receivedAt: "2026-05-12T00:00:00.000Z",
    });
    expect(missing.body).toStrictEqual({ error: "invalid_token" });
    expect(expired.body).toStrictEqual({ error: "expired_token" });
  });
});
