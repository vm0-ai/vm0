import { randomUUID } from "node:crypto";

import type { ConnectorAuthMethodId } from "@vm0/api-contracts/contracts/connector-identity";
import { connectorOauthStartResponseSchema } from "@vm0/api-contracts/contracts/connector-schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import {
  API_TEST_CONNECTOR_CATALOG,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";
const API_ORIGIN = "https://api.vm0.ai";
const WEB_ORIGIN = "https://www.vm0.ai";
const LOCAL_ORIGIN = "http://localhost:3000";
const LOCAL_WEB_ORIGIN = "https://www.vm0.ai:8443";
const AUTH_REQUEST_USER_ID_PREFIX = "user_zero_connectors_oauth_start_";
const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

function oauthStartUrl(type: string, origin = BASE_URL): string {
  return new URL(`/api/zero/connectors/${type}/oauth/start`, origin).toString();
}

function authHeaders(): HeadersInit {
  return { authorization: "Bearer clerk-session" };
}

function mockAuthenticatedSession(): void {
  mocks.clerk.session(
    `${AUTH_REQUEST_USER_ID_PREFIX}${randomUUID()}`,
    `org_${randomUUID()}`,
  );
}

function mockOAuthEnv(): void {
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
  mockOptionalEnv("AIRTABLE_OAUTH_CLIENT_ID", "airtable-test-client-id");
  mockOptionalEnv(
    "AIRTABLE_OAUTH_CLIENT_SECRET",
    "airtable-test-client-secret",
  );
  mockOptionalEnv("CLOUDFLARE_OAUTH_CLIENT_ID", "cloudflare-test-client-id");
  mockOptionalEnv(
    "CLOUDFLARE_OAUTH_CLIENT_SECRET",
    "cloudflare-test-client-secret",
  );
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-test-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-test-client-secret");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_ID", "linear-test-client-id");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_SECRET", "linear-test-client-secret");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
  mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
  mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
}

function expectCloudflareAuthorizationScopes(authorizationUrl: URL): void {
  const method = API_TEST_CONNECTOR_CATALOG.connectors
    .find((connector) => {
      return connector.connectorRef === "cloudflare";
    })
    ?.authMethods.find((authMethod) => {
      return authMethod.id === "oauth";
    });
  if (method?.grant.kind !== "auth-code") {
    throw new Error("Expected Cloudflare OAuth auth-code fixture");
  }
  expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toStrictEqual(
    method.grant.scopes,
  );
  expect(method.grant.scopes).toContain("offline_access");
}

async function requestOauthStart(
  type: string,
  options: {
    readonly authMethod?: ConnectorAuthMethodId;
    readonly authenticated?: boolean;
    readonly callbackTarget?: "app";
    readonly headers?: HeadersInit;
    readonly origin?: string;
  } = {},
): Promise<Response> {
  if (options.authenticated) {
    mockAuthenticatedSession();
  }
  const headers = new Headers(options.headers);
  if (options.authenticated) {
    headers.set("authorization", "Bearer clerk-session");
  }
  headers.set("content-type", "application/json");
  const app = createApp({ signal: context.signal });
  return await app.request(oauthStartUrl(type, options.origin), {
    method: "POST",
    headers,
    body: JSON.stringify({
      authMethod: options.authMethod ?? "oauth",
      ...(options.callbackTarget
        ? { callbackTarget: options.callbackTarget }
        : {}),
    }),
  });
}

async function authorizationUrlFromResponse(response: Response): Promise<URL> {
  const body = connectorOauthStartResponseSchema.parse(await response.json());
  return new URL(body.authorizationUrl);
}

async function providerAuthorizationUrl(continuationUrl: URL): Promise<URL> {
  const response = await requestOauthContinuation(continuationUrl);
  expect(response.status).toBe(307);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected connector OAuth handoff to redirect");
  }
  return new URL(location);
}

async function requestOauthContinuation(
  continuationUrl: URL,
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(continuationUrl.toString());
}

function expectOauthState(authorizationUrl: URL): string {
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toMatch(/^[0-9a-f]{64}$/);
  return state!;
}

function legacyContinuationUrl(
  connectorType: string,
  authorizationUrl: URL,
): URL {
  const continuationUrl = new URL(
    `/api/zero/connectors/${connectorType}/oauth/continue`,
    API_ORIGIN,
  );
  continuationUrl.searchParams.set("state", expectOauthState(authorizationUrl));
  return continuationUrl;
}

async function rejectProviderAuthorization(
  authorizationUrl: URL,
): Promise<void> {
  const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
  const state = authorizationUrl.searchParams.get("state");
  expect(redirectUri).toBeTruthy();
  expect(state).toBeTruthy();

  const callbackUrl = new URL(redirectUri!);
  callbackUrl.searchParams.set("error", "access_denied");
  callbackUrl.searchParams.set("state", state!);

  const app = createApp({ signal: context.signal });
  await app.request(callbackUrl.toString());
}

describe("POST /api/zero/connectors/:type/oauth/start", () => {
  beforeEach(() => {
    mockEnv("VM0_API_BACKEND_URL", API_ORIGIN);
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    mockOAuthEnv();
  });

  afterEach(() => {
    clearMockNow();
  });

  it("allows auth-code OAuth start when the connector feature is disabled", async () => {
    const response = await requestOauthStart("test-oauth", {
      authenticated: true,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expectOauthState(authorizationUrl);
  });

  it("starts YouTube OAuth without a feature switch", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("youtube", {
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "google-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/youtube/callback`,
    );
    expect(
      authorizationUrl.searchParams.get("scope")?.split(" "),
    ).toStrictEqual([...YOUTUBE_OAUTH_SCOPES]);
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("returns the provider authorization URL without an API redirect", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
      origin: WEB_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/github/callback`,
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("continues OAuth handoff URLs issued before deployment", async () => {
    const response = await requestOauthStart("github", {
      authenticated: true,
      origin: API_ORIGIN,
    });
    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);

    const redirectedAuthorizationUrl = await providerAuthorizationUrl(
      legacyContinuationUrl("github", authorizationUrl),
    );

    expect(redirectedAuthorizationUrl.toString()).toBe(
      authorizationUrl.toString(),
    );
  });

  it("rejects an OAuth handoff whose state does not exist", async () => {
    const continuationUrl = new URL(
      "/api/zero/connectors/github/oauth/continue",
      API_ORIGIN,
    );
    continuationUrl.searchParams.set("state", "0".repeat(64));

    const app = createApp({ signal: context.signal });
    const response = await app.request(continuationUrl.toString());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "OAuth handoff not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("rejects an OAuth handoff for a different connector type", async () => {
    const response = await requestOauthStart("github", {
      authenticated: true,
      origin: API_ORIGIN,
    });
    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    const continuationUrl = legacyContinuationUrl("notion", authorizationUrl);

    const continueResponse = await requestOauthContinuation(continuationUrl);

    expect(continueResponse.status).toBe(404);
    await expect(continueResponse.json()).resolves.toStrictEqual({
      error: {
        message: "OAuth handoff not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("rejects an expired OAuth handoff", async () => {
    const startedAt = new Date("2026-07-22T00:00:00.000Z");
    mockNow(startedAt);
    const response = await requestOauthStart("github", {
      authenticated: true,
      origin: API_ORIGIN,
    });
    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    const continuationUrl = legacyContinuationUrl("github", authorizationUrl);
    mockNow(new Date(startedAt.getTime() + 15 * 60 * 1000));

    const continueResponse = await requestOauthContinuation(continuationUrl);

    expect(continueResponse.status).toBe(404);
    await expect(continueResponse.json()).resolves.toStrictEqual({
      error: {
        message: "OAuth handoff not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("rejects an OAuth handoff after its callback claims it", async () => {
    const response = await requestOauthStart("github", {
      authenticated: true,
      origin: API_ORIGIN,
    });
    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    const continuationUrl = legacyContinuationUrl("github", authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);

    const continueResponse = await requestOauthContinuation(continuationUrl);

    expect(continueResponse.status).toBe(404);
    await expect(continueResponse.json()).resolves.toStrictEqual({
      error: {
        message: "OAuth handoff not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("uses the configured web origin for local OAuth callback URLs", async () => {
    mockEnv("VM0_WEB_URL", LOCAL_WEB_ORIGIN);
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
      origin: LOCAL_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${LOCAL_WEB_ORIGIN}/api/connectors/github/callback`,
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses App callbacks for allowlisted connectors", async () => {
    mockEnv("APP_URL", "https://app.vm0.test");
    mockAuthenticatedSession();

    const response = await requestOauthStart("google-maps", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.vm0.test/connectors/google-maps/callback",
    );
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("stores provider PKCE context for server-side OAuth handoff", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("airtable", {
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://airtable.com/oauth2/v1/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "airtable-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/airtable/callback`,
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps API-origin callbacks on the API when the app target is requested", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: WEB_ORIGIN,
      callbackTarget: "app",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://dash.cloudflare.com/oauth2/auth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "cloudflare-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/connectors/cloudflare/callback`,
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps API-origin OAuth callbacks on the PR API when WWW uses Omby staging", async () => {
    mockAuthenticatedSession();
    mockEnv("VM0_API_BACKEND_URL", "https://pr-19337-api.vm6.ai");
    mockEnv("VM0_WEB_URL", "https://staging-www.omby.ai");

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: "https://pr-19337-api.vm6.ai",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://pr-19337-api.vm6.ai/api/connectors/cloudflare/callback",
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses the canonical API origin when VM0_API_BACKEND_URL is localhost", async () => {
    mockAuthenticatedSession();
    mockEnv("VM0_API_BACKEND_URL", LOCAL_ORIGIN);
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: LOCAL_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/connectors/cloudflare/callback`,
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps Cloudflare OAuth callbacks on the canonical API origin when VM0_API_BACKEND_URL is a tunnel", async () => {
    mockAuthenticatedSession();
    mockEnv("VM0_API_BACKEND_URL", "https://tunnel-liangyou-vm2-www.vm7.ai");
    mockEnv("VM0_WEB_URL", "https://www.vm7.ai:8443");

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: "https://www.vm7.ai:8443",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.vm7.ai:8443/api/connectors/cloudflare/callback",
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("returns 401 instead of relying on browser cookies when unauthenticated", async () => {
    const response = await requestOauthStart("github");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 400 when starting OAuth for a connector without an auth-code grant", async () => {
    const response = await requestOauthStart("serpapi", {
      authenticated: true,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "serpapi connector does not use an auth-code grant",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when starting browser OAuth for a device authorization connector", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("test-oauth-device", {
      headers: authHeaders(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "test-oauth-device connector does not use an auth-code grant",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when starting OAuth with a missing selected auth method", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      authMethod: "api-token",
      headers: authHeaders(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "github connector does not have api-token auth method",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 500 when the auth method lacks executable platform configuration", async () => {
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
    await installApiTestConnectorCatalog();
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Connector execution is not configured",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
  });
});
