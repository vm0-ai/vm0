import { randomUUID } from "node:crypto";

import type { ConnectorAuthMethodId } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorOauthStartResponseSchema } from "@okouai/api-contracts/contracts/connector-schemas";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { clearMockNow } from "../../../lib/time";
import {
  API_TEST_CONNECTOR_CATALOG,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import { connectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...connectorsSlugCallbackRoutes,
  ...connectorsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);

const BASE_URL = "https://app.vm0.test";
const API_ORIGIN = "https://api.vm0.ai";
const OKOU_API_ORIGIN = "https://api.okou.ai";
const WEB_ORIGIN = "https://www.vm0.ai";
const LOCAL_ORIGIN = "http://localhost:3000";
const LOCAL_WEB_ORIGIN = "https://www.vm0.ai:8443";
const BOX_OAUTH_TOKEN_URL = "https://api.box.com/oauth2/token";
const BOX_CURRENT_USER_URL = "https://api.box.com/2.0/users/me";
const CLOUDFLARE_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_USERINFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_OPENID_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";
const HUBSPOT_OAUTH_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_TOKEN_INFO_URL = "https://api.hubapi.com/oauth/v1/access-tokens";
const META_ADS_OAUTH_TOKEN_URL =
  "https://graph.facebook.com/v22.0/oauth/access_token";
const META_ADS_USER_URL = "https://graph.facebook.com/v22.0/me";
const NOTION_OAUTH_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const TIKTOK_ADS_OAUTH_TOKEN_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";
const AIRTABLE_OAUTH_TOKEN_URL = "https://airtable.com/oauth2/v1/token";
const AIRTABLE_WHOAMI_URL = "https://api.airtable.com/v0/meta/whoami";
const AUTH_REQUEST_USER_ID_PREFIX = "user_zero_connectors_oauth_start_";
const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

function oauthStartUrl(connectorSlug: string, origin = BASE_URL): string {
  return new URL(
    `/api/connectors/${connectorSlug}/oauth/start`,
    origin,
  ).toString();
}

function authHeaders(): Record<string, string> {
  return { authorization: "Bearer clerk-session" };
}

function mockAuthenticatedSession(): void {
  mocks.clerk.session(
    `${AUTH_REQUEST_USER_ID_PREFIX}${randomUUID()}`,
    `org_${randomUUID()}`,
  );
}

function mockOAuthEnv(): void {
  mockOptionalEnv("BOX_OAUTH_CLIENT_ID", "box-test-client-id");
  mockOptionalEnv("BOX_OAUTH_CLIENT_SECRET", "box-test-client-secret");
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
  mockOptionalEnv("HUBSPOT_OAUTH_CLIENT_ID", "hubspot-test-client-id");
  mockOptionalEnv("HUBSPOT_OAUTH_CLIENT_SECRET", "hubspot-test-client-secret");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_ID", "linear-test-client-id");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_SECRET", "linear-test-client-secret");
  mockOptionalEnv("META_ADS_OAUTH_CLIENT_ID", "meta-ads-test-client-id");
  mockOptionalEnv(
    "META_ADS_OAUTH_CLIENT_SECRET",
    "meta-ads-test-client-secret",
  );
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
  mockOptionalEnv("TIKTOK_ADS_OAUTH_CLIENT_ID", "tiktok-ads-test-client-id");
  mockOptionalEnv(
    "TIKTOK_ADS_OAUTH_CLIENT_SECRET",
    "tiktok-ads-test-client-secret",
  );
  mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
  mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
}

function expectCloudflareAuthorizationScopes(authorizationUrl: URL): void {
  const method = API_TEST_CONNECTOR_CATALOG.connectors
    .find((connector) => {
      return connector.slug === "cloudflare";
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
  connectorSlug: string,
  options: {
    readonly accountIntent?: "add" | "single-account";
    readonly authMethod?: ConnectorAuthMethodId;
    readonly authenticated?: boolean;
    readonly callbackTarget?: "app";
    readonly headers?: RequestInit["headers"];
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
  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  return await app.request(oauthStartUrl(connectorSlug, options.origin), {
    method: "POST",
    headers,
    body: JSON.stringify({
      authMethod: options.authMethod ?? "oauth",
      account: { intent: options.accountIntent ?? "single-account" },
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

function expectOauthState(authorizationUrl: URL): string {
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toMatch(/^[0-9a-f]{64}$/);
  return state!;
}

function expectOkouOauthState(authorizationUrl: URL): string {
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toMatch(/^okou\.[0-9a-f]{64}$/u);
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

  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  await app.request(callbackUrl.toString());
}

describe("POST /api/connectors/:connectorSlug/oauth/start", () => {
  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);
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

  it("returns the future connection id for an unnamed account addition", async () => {
    const response = await requestOauthStart("test-oauth", {
      accountIntent: "add",
      authenticated: true,
    });

    expect(response.status).toBe(200);
    const body = connectorOauthStartResponseSchema.parse(await response.json());
    expect(body.connectionId).toBeTruthy();
    const authorizationUrl = new URL(body.authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps an omitted callback target on the existing Web callback", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("youtube", {
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
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
    expectOkouOauthState(authorizationUrl);
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

  it("uses the configured web origin for local OAuth callback URLs", async () => {
    mockEnv("OKOU_WEB_URL", LOCAL_WEB_ORIGIN);
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

  it("uses the direct Okou App callback for a ready Google connector", async () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("google-maps", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/google-maps/callback",
    );
    expectOkouOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps the VM0 App callback for a ready Google connector", async () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("google-maps", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.vm0.ai/connectors/google-maps/callback",
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses persisted brand context for App callback redirects", async () => {
    mockEnv("APP_URL", "https://app.vm0.ai");

    const callbackLocation = async (
      publicBrand: "vm0" | "okou",
      connectorSlug = "google-maps",
    ): Promise<{ readonly state: string; readonly location: URL }> => {
      mockAuthenticatedSession();
      const response = await requestOauthStart(connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: publicBrand === "okou" ? OKOU_API_ORIGIN : API_ORIGIN,
      });
      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        connectorSlug === "slack"
          ? `${WEB_ORIGIN}/api/connectors/slack/callback`
          : `https://app.${publicBrand === "okou" ? "okou" : "vm0"}.ai/connectors/google-maps/callback`,
      );
      const state = authorizationUrl.searchParams.get("state") ?? "";

      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const callback = await app.request(
        `${OKOU_API_ORIGIN}/api/connectors/${connectorSlug}/callback?${new URLSearchParams(
          {
            error: "access_denied",
            state,
          },
        )}`,
        { headers: { "x-vm0-web-origin": "https://okou.ai" } },
      );
      expect(callback.status).toBe(307);
      return {
        state,
        location: new URL(callback.headers.get("location") ?? ""),
      };
    };

    const okou = await callbackLocation("okou");
    expect(okou.state).toMatch(/^okou\.[0-9a-f]{64}$/u);
    expect(okou.location.origin).toBe("https://app.okou.ai");
    expect(okou.location.pathname).toBe("/connector/error");

    const legacyCallback = await callbackLocation("okou", "slack");
    expect(legacyCallback.state).toMatch(/^okou\.[0-9a-f]{64}$/u);
    expect(legacyCallback.location.origin).toBe("https://app.okou.ai");

    const vm0 = await callbackLocation("vm0");
    expect(vm0.state).toMatch(/^[0-9a-f]{64}$/u);
    expect(vm0.location.origin).toBe("https://app.vm0.ai");
    expect(vm0.location.pathname).toBe("/connector/error");
  });

  it("reuses the persisted exact redirect URI for a PKCE token exchange", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(AIRTABLE_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "airtable-test-token",
          refresh_token: "airtable-refresh-token",
          expires_in: 3600,
          scope: "data.records:read",
        });
      }),
      http.get(AIRTABLE_WHOAMI_URL, () => {
        return HttpResponse.json({
          id: "airtable-user-123",
          email: "airtable@example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("airtable", {
      accountIntent: "add",
      callbackTarget: "app",
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const startBody = connectorOauthStartResponseSchema.parse(
      await response.json(),
    );
    const authorizationUrl = new URL(startBody.authorizationUrl);
    expect(startBody.connectionId).toBeTruthy();
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://airtable.com/oauth2/v1/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "airtable-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.vm0.ai/connectors/airtable/callback");
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const state = expectOkouOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${OKOU_API_ORIGIN}/api/connectors/airtable/callback?${new URLSearchParams(
        {
          code: "airtable-authorization-code",
          state,
        },
      )}`,
      { headers: { "x-vm0-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    expect(new URL(callback.headers.get("location") ?? "").origin).toBe(
      "https://app.okou.ai",
    );
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
    expect(tokenBodies[0]?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/u);
    const connected = await app.request(
      `${API_ORIGIN}/api/connectors/airtable`,
      { headers: authHeaders() },
    );
    expect(connected.status).toBe(200);
    await expect(connected.json()).resolves.toMatchObject({
      id: startBody.connectionId,
    });
  });

  it("reuses the direct Okou redirect URI for a Google token exchange", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "gmail-test-token",
          refresh_token: "gmail-refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      }),
      http.get(GOOGLE_OPENID_USERINFO_URL, () => {
        return HttpResponse.json({
          sub: "gmail-user-123",
          email: "gmail@example.test",
          name: "Gmail Test User",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("gmail", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/gmail/callback");
    const state = expectOkouOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${OKOU_API_ORIGIN}/api/connectors/gmail/callback?${new URLSearchParams({
        code: "gmail-authorization-code",
        state,
      })}`,
      { headers: { "x-vm0-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("uses the direct Okou App callback for Box and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(BOX_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "box-test-token",
          refresh_token: "box-refresh-token",
          expires_in: 3600,
          scope: "root_readwrite",
        });
      }),
      http.get(BOX_CURRENT_USER_URL, () => {
        return HttpResponse.json({
          id: "box-user-123",
          name: "Box Test User",
          login: "box@example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("box", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://account.box.com/api/oauth2/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "box-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/box/callback");
    const state = expectOkouOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${OKOU_API_ORIGIN}/api/connectors/box/callback?${new URLSearchParams({
        code: "box-authorization-code",
        state,
      })}`,
      { headers: { "x-vm0-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("uses the direct Okou App callback for HubSpot and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(HUBSPOT_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "hubspot-test-token",
          refresh_token: "hubspot-refresh-token",
          expires_in: 1800,
        });
      }),
      http.get(`${HUBSPOT_TOKEN_INFO_URL}/hubspot-test-token`, () => {
        return HttpResponse.json({
          user_id: 123,
          user: "hubspot@example.test",
          hub_domain: "example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("hubspot", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://app.hubspot.com/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "hubspot-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/hubspot/callback");
    const state = expectOkouOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${OKOU_API_ORIGIN}/api/connectors/hubspot/callback?${new URLSearchParams(
        {
          code: "hubspot-authorization-code",
          state,
        },
      )}`,
      { headers: { "x-vm0-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("uses the direct Okou App callback for Meta Ads and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(META_ADS_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "meta-ads-short-lived-token",
          token_type: "bearer",
          expires_in: 3600,
        });
      }),
      http.get(META_ADS_OAUTH_TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "meta-ads-long-lived-token",
          token_type: "bearer",
          expires_in: 5_184_000,
        });
      }),
      http.get(META_ADS_USER_URL, () => {
        return HttpResponse.json({
          id: "meta-ads-user-123",
          name: "Meta Ads Test User",
          email: "meta-ads@example.test",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("meta-ads", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://www.facebook.com/v22.0/dialog/oauth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "meta-ads-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe(
      "https://app.okou.ai/connectors/meta-ads/callback",
    );
    const state = expectOkouOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${OKOU_API_ORIGIN}/api/connectors/meta-ads/callback?${new URLSearchParams(
        {
          code: "meta-ads-authorization-code",
          state,
        },
      )}`,
      { headers: { "x-vm0-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("uses the direct Okou App callback for TikTok Ads without adding a token redirect URI", async () => {
    const tokenBodies: unknown[] = [];
    server.use(
      http.post(TIKTOK_ADS_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(await request.json());
        return HttpResponse.json({
          data: {
            access_token: "tiktok-ads-test-token",
            advertiser_ids: ["1234567890"],
          },
          request_id: "tiktok-ads-request-id",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("tiktok-ads", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://business-api.tiktok.com/portal/auth",
    );
    expect(authorizationUrl.searchParams.get("app_id")).toBe(
      "tiktok-ads-test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/connectors/tiktok-ads/callback",
    );
    const state = expectOkouOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${OKOU_API_ORIGIN}/api/connectors/tiktok-ads/callback?${new URLSearchParams(
        {
          auth_code: "tiktok-ads-authorization-code",
          state,
        },
      )}`,
      { headers: { "x-vm0-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toStrictEqual([
      {
        app_id: "tiktok-ads-test-client-id",
        secret: "tiktok-ads-test-client-secret",
        auth_code: "tiktok-ads-authorization-code",
      },
    ]);
  });

  it.each(["box", "hubspot", "meta-ads", "tiktok-ads"] as const)(
    "keeps the VM0 App callback for %s",
    async (connectorSlug) => {
      mockEnv("APP_URL", "https://app.vm0.ai");
      mockAuthenticatedSession();

      const response = await requestOauthStart(connectorSlug, {
        callbackTarget: "app",
        headers: authHeaders(),
        origin: API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `https://app.vm0.ai/connectors/${connectorSlug}/callback`,
      );
      expectOauthState(authorizationUrl);
      await rejectProviderAuthorization(authorizationUrl);
    },
  );

  it.each(["box", "hubspot", "meta-ads", "tiktok-ads"] as const)(
    "keeps an omitted %s callback target on the existing Web callback",
    async (connectorSlug) => {
      mockAuthenticatedSession();

      const response = await requestOauthStart(connectorSlug, {
        headers: authHeaders(),
        origin: OKOU_API_ORIGIN,
      });

      expect(response.status).toBe(200);
      const authorizationUrl = await authorizationUrlFromResponse(response);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        `${WEB_ORIGIN}/api/connectors/${connectorSlug}/callback`,
      );
      expectOkouOauthState(authorizationUrl);
      await rejectProviderAuthorization(authorizationUrl);
    },
  );

  it("uses the direct Okou App callback for Notion and reuses its exact redirect URI", async () => {
    const tokenBodies: unknown[] = [];
    server.use(
      http.post(NOTION_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(await request.json());
        return HttpResponse.json({
          access_token: "notion-test-token",
          refresh_token: "notion-refresh-token",
          expires_in: 3600,
          owner: {
            user: {
              id: "notion-user-123",
              name: "Notion Test User",
              person: { email: "notion@example.test" },
            },
          },
        });
      }),
    );
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("notion", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "notion-test-client-id",
    );
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe("https://app.okou.ai/connectors/notion/callback");
    const state = expectOkouOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${OKOU_API_ORIGIN}/api/connectors/notion/callback?${new URLSearchParams({
        code: "notion-authorization-code",
        state,
      })}`,
      { headers: { "x-vm0-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toStrictEqual([
      {
        grant_type: "authorization_code",
        code: "notion-authorization-code",
        redirect_uri: redirectUri,
      },
    ]);
  });

  it("keeps the VM0 App callback for Notion", async () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("notion", {
      callbackTarget: "app",
      headers: authHeaders(),
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.vm0.ai/connectors/notion/callback",
    );
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps an omitted Notion callback target on the existing Web callback", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("notion", {
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/notion/callback`,
    );
    expectOkouOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps an Okou start on the VM0 App callback when the provider is not ready", async () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("test-oauth", {
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
      callbackTarget: "app",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.vm0.ai/connectors/test-oauth/callback",
    );
    expectOkouOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("uses the direct Okou App callback for Cloudflare and reuses its exact redirect URI", async () => {
    const tokenBodies: URLSearchParams[] = [];
    server.use(
      http.post(CLOUDFLARE_OAUTH_TOKEN_URL, async ({ request }) => {
        tokenBodies.push(new URLSearchParams(await request.text()));
        return HttpResponse.json({
          access_token: "cloudflare-test-token",
          refresh_token: "cloudflare-refresh-token",
          expires_in: 3600,
          scope: "offline_access",
        });
      }),
      http.get(CLOUDFLARE_USERINFO_URL, () => {
        return HttpResponse.json({
          sub: "cloudflare-user-123",
          email: "cloudflare@example.test",
          name: "Cloudflare Test User",
        });
      }),
    );
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
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
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri).toBe(
      "https://app.okou.ai/connectors/cloudflare/callback",
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    const state = expectOkouOauthState(authorizationUrl);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const callback = await app.request(
      `${OKOU_API_ORIGIN}/api/connectors/cloudflare/callback?${new URLSearchParams(
        {
          code: "cloudflare-authorization-code",
          state,
        },
      )}`,
      { headers: { "x-vm0-web-origin": "https://okou.ai" } },
    );

    expect(callback.status).toBe(307);
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.origin).toBe("https://app.okou.ai");
    expect(callbackLocation.pathname).toBe("/connector/success");
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
  });

  it("keeps the VM0 App callback for Cloudflare", async () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: API_ORIGIN,
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
      "https://app.vm0.ai/connectors/cloudflare/callback",
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps an omitted Cloudflare callback target on the existing API callback", async () => {
    mockAuthenticatedSession();

    const response = await requestOauthStart("cloudflare", {
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/connectors/cloudflare/callback`,
    );
    expectCloudflareAuthorizationScopes(authorizationUrl);
    expectOkouOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps denylisted callbacks on the legacy path", async () => {
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAuthenticatedSession();

    const response = await requestOauthStart("slack", {
      headers: authHeaders(),
      origin: OKOU_API_ORIGIN,
      callbackTarget: "app",
    });

    expect(response.status).toBe(200);
    const authorizationUrl = await authorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/slack/callback`,
    );
    expectOkouOauthState(authorizationUrl);
    await rejectProviderAuthorization(authorizationUrl);
  });

  it("keeps API-origin OAuth callbacks on the PR API when WWW uses Omby staging", async () => {
    mockAuthenticatedSession();
    mockEnv("OKOU_API_BACKEND_URL", "https://pr-19337-api.vm6.ai");
    mockEnv("OKOU_WEB_URL", "https://staging-www.omby.ai");

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

  it("uses the canonical API origin when OKOU_API_BACKEND_URL is localhost", async () => {
    mockAuthenticatedSession();
    mockEnv("OKOU_API_BACKEND_URL", LOCAL_ORIGIN);
    mockEnv("OKOU_WEB_URL", WEB_ORIGIN);

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

  it("keeps Cloudflare OAuth callbacks on the canonical API origin when OKOU_API_BACKEND_URL is a tunnel", async () => {
    mockAuthenticatedSession();
    mockEnv("OKOU_API_BACKEND_URL", "https://tunnel-liangyou-vm2-www.vm7.ai");
    mockEnv("OKOU_WEB_URL", "https://www.vm7.ai:8443");

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

  it("returns 403 when the auth method lacks executable platform configuration", async () => {
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
    await installApiTestConnectorCatalog();
    mockAuthenticatedSession();

    const response = await requestOauthStart("github", {
      headers: authHeaders(),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "github connector is not available",
        code: "FORBIDDEN",
      },
    });
  });
});
