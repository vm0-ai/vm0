import { randomUUID } from "node:crypto";

import type { ConnectorRegistryAuthMethodId } from "@vm0/connectors/connectors";
import { getConnectorAuthMethodAuthCodeGrantConfig } from "@vm0/connectors/connector-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { zeroConnectorsRoutes } from "../zero-connectors";
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
  mockOptionalEnv("DOCUSIGN_OAUTH_CLIENT_ID", "docusign-test-client-id");
  mockOptionalEnv(
    "DOCUSIGN_OAUTH_CLIENT_SECRET",
    "docusign-test-client-secret",
  );
  mockOptionalEnv("DROPBOX_OAUTH_CLIENT_ID", "dropbox-test-client-id");
  mockOptionalEnv("DROPBOX_OAUTH_CLIENT_SECRET", "dropbox-test-client-secret");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-test-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-test-client-secret");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_ID", "linear-test-client-id");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_SECRET", "linear-test-client-secret");
  mockOptionalEnv("MERCURY_OAUTH_CLIENT_ID", "mercury-test-client-id");
  mockOptionalEnv("MERCURY_OAUTH_CLIENT_SECRET", "mercury-test-client-secret");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
  mockOptionalEnv("REDDIT_OAUTH_CLIENT_ID", "reddit-test-client-id");
  mockOptionalEnv("REDDIT_OAUTH_CLIENT_SECRET", "reddit-test-client-secret");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_ID", "strava-test-client-id");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_SECRET", "strava-test-client-secret");
  mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
  mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
}

function expectCloudflareAuthorizationScopes(authorizationUrl: URL): void {
  const grant = getConnectorAuthMethodAuthCodeGrantConfig(
    "cloudflare",
    "oauth",
  );
  expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toStrictEqual(
    grant.scopes,
  );
  expect(grant.scopes).toContain("offline_access");
}

async function requestOauthStart(
  type: string,
  options: {
    readonly authMethod?: ConnectorRegistryAuthMethodId;
    readonly authenticated?: boolean;
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
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: zeroConnectorsRoutes,
  });
  return await app.request(oauthStartUrl(type, options.origin), {
    method: "POST",
    headers,
    body: JSON.stringify({ authMethod: options.authMethod ?? "oauth" }),
  });
}

async function continuationUrlFromResponse(response: Response): Promise<URL> {
  const body = (await response.json()) as {
    readonly authorizationUrl: string;
  };
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
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: zeroConnectorsRoutes,
  });
  return await app.request(continuationUrl.toString());
}

async function authorizationUrlFromResponse(response: Response): Promise<URL> {
  return await providerAuthorizationUrl(
    await continuationUrlFromResponse(response),
  );
}

function expectOauthState(authorizationUrl: URL): string {
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toMatch(/^[0-9a-f]{64}$/);
  return state!;
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

  it("starts Google Cloud OAuth without a feature switch", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("google-cloud", {
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    const scopes = new Set(
      authorizationUrl.searchParams.get("scope")?.split(" ") ?? [],
    );
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "google-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/google-cloud/callback`,
    );
    expect(scopes.has("openid")).toBeTruthy();
    expect(
      scopes.has("https://www.googleapis.com/auth/userinfo.email"),
    ).toBeTruthy();
    expect(
      scopes.has("https://www.googleapis.com/auth/cloud-platform"),
    ).toBeTruthy();
    expect(
      scopes.has("https://www.googleapis.com/auth/appengine.admin"),
    ).toBeTruthy();
    expect(
      scopes.has("https://www.googleapis.com/auth/sqlservice.login"),
    ).toBeTruthy();
    expect(scopes.has("https://www.googleapis.com/auth/compute")).toBeTruthy();
    expect(scopes.size).toBe(6);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
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

  it("returns an API OAuth handoff that redirects to the provider authorization URL", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
      origin: WEB_ORIGIN,
    });

    expect(response.status).toBe(200);
    const continuationUrl = await continuationUrlFromResponse(response);
    expect(`${continuationUrl.origin}${continuationUrl.pathname}`).toBe(
      `${API_ORIGIN}/api/zero/connectors/github/oauth/continue`,
    );
    const state = expectOauthState(continuationUrl);

    const authorizationUrl = await providerAuthorizationUrl(continuationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/github/callback`,
    );
    expect(authorizationUrl.searchParams.get("state")).toBe(state);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("rejects an OAuth handoff whose state does not exist", async () => {
    const continuationUrl = new URL(
      "/api/zero/connectors/github/oauth/continue",
      API_ORIGIN,
    );
    continuationUrl.searchParams.set("state", "0".repeat(64));

    const app = createAppWithRoutes({
      signal: context.signal,
      routes: zeroConnectorsRoutes,
    });
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
    const continuationUrl = await continuationUrlFromResponse(response);
    continuationUrl.pathname = continuationUrl.pathname.replace(
      "/github/",
      "/notion/",
    );

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
    const continuationUrl = await continuationUrlFromResponse(response);
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
    const continuationUrl = await continuationUrlFromResponse(response);
    const authorizationUrl = await providerAuthorizationUrl(continuationUrl);
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

  it("uses the configured API origin for Cloudflare OAuth callback URLs", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: WEB_ORIGIN,
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

  it("returns 500 when auth client is not configured", async () => {
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "github auth client not configured",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
  });
});
