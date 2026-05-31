import { randomUUID } from "node:crypto";

import type {
  ConnectorAuthClientConfig,
  ConnectorAuthMethodId,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { getConnectorAuthMethod } from "@vm0/connectors/connector-utils";
import { testOauthProvider } from "@vm0/connectors/auth-providers/oauth/providers/test-oauth-provider";
import { connectors } from "@vm0/db/schema/connector";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq, like } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { testContext } from "../../../__tests__/test-helpers";
import { encryptSecretForTests } from "./helpers/encrypt-secret";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";
const API_ORIGIN = "https://api.vm0.ai";
const WEB_ORIGIN = "https://www.vm0.ai";
const LOCAL_ORIGIN = "http://localhost:3000";
const LOCAL_WEB_ORIGIN = "https://www.vm0.ai:8443";
const AUTH_REQUEST_USER_ID_PREFIX = "user_zero_connectors_authorize_";

function authorizeUrl(
  type: string,
  session?: string,
  origin = BASE_URL,
): string {
  const url = new URL(`/api/zero/connectors/${type}/authorize`, origin);
  if (session) {
    url.searchParams.set("session", session);
  }
  return url.toString();
}

function oauthStartUrl(type: string, origin = BASE_URL): string {
  return new URL(`/api/zero/connectors/${type}/oauth/start`, origin).toString();
}

function sessionHeaders(): HeadersInit {
  return { cookie: "__session=opaque" };
}

function mockOAuthEnv(): void {
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
  mockOptionalEnv("AIRTABLE_OAUTH_CLIENT_ID", "airtable-test-client-id");
  mockOptionalEnv(
    "AIRTABLE_OAUTH_CLIENT_SECRET",
    "airtable-test-client-secret",
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

const dynamicPublicClient = {
  clientRegistration: "dynamic",
  clientType: "public",
} as const satisfies ConnectorAuthClientConfig;

async function enableConnectorFeature(
  userId: string,
  orgId: string,
  featureKey: FeatureSwitchKey,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [featureKey]: true },
  });
}

function useDynamicTestOAuthAuthorize(): () => void {
  const method = getConnectorAuthMethod("test-oauth", "oauth");
  if (method?.grant.kind !== "auth-code") {
    throw new Error("test-oauth OAuth config is missing");
  }

  const mutableMethod = method as { client: ConnectorAuthClientConfig };
  const originalClient = mutableMethod.client;
  const provider = testOauthProvider;
  const originalBuildAuthUrl = provider.grant.buildAuthUrl;

  mutableMethod.client = dynamicPublicClient;
  provider.grant.buildAuthUrl = (args) => {
    expect(args.clientId).toBeUndefined();
    return {
      url: `https://dynamic-oauth.test/authorize?state=${args.state}`,
      oauthContext: "dynamic-oauth-context; tenant=example",
    };
  };

  return () => {
    mutableMethod.client = originalClient;
    provider.grant.buildAuthUrl = originalBuildAuthUrl;
  };
}

async function requestAuthorize(
  type: string,
  options: {
    readonly session?: string;
    readonly authenticated?: boolean;
    readonly withSession?: boolean;
    readonly authMethod?: ConnectorAuthMethodId;
    readonly headers?: HeadersInit;
    readonly origin?: string;
  } = {},
): Promise<Response> {
  const userId = `${AUTH_REQUEST_USER_ID_PREFIX}${randomUUID()}`;
  if (options.authenticated) {
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
  }
  const session =
    options.session ??
    (options.authenticated && options.withSession !== false
      ? await createPendingConnectorSession({
          userId,
          type,
          authMethod: options.authMethod,
        })
      : undefined);
  const headers = new Headers(options.headers);
  if (options.authenticated) {
    headers.set("cookie", "__session=opaque");
  }
  const app = createApp({ signal: context.signal });
  return await app.request(authorizeUrl(type, session, options.origin), {
    method: "GET",
    headers,
  });
}

async function createPendingConnectorSession(args: {
  readonly userId: string;
  readonly type?: string;
  readonly authMethod?: ConnectorAuthMethodId;
}): Promise<string> {
  const [session] = await store
    .set(writeDb$)
    .insert(connectorSessions)
    .values({
      code: `${randomUUID().slice(0, 4).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      type: args.type ?? "github",
      authMethod: args.authMethod ?? "oauth",
      userId: args.userId,
      status: "pending",
      expiresAt: new Date(nowDate().getTime() + 600_000),
    })
    .returning({ id: connectorSessions.id });
  if (!session) {
    throw new Error("Failed to create connector session");
  }
  return session.id;
}

async function requestOauthStart(
  type: string,
  options: {
    readonly authMethod?: ConnectorAuthMethodId;
    readonly authenticated?: boolean;
    readonly headers?: HeadersInit;
    readonly origin?: string;
  } = {},
): Promise<Response> {
  if (options.authenticated) {
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(`${AUTH_REQUEST_USER_ID_PREFIX}${randomUUID()}`, orgId);
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
    body: JSON.stringify({ authMethod: options.authMethod ?? "oauth" }),
  });
}

describe("GET /api/zero/connectors/:type/authorize", () => {
  const orgIds: string[] = [];
  let restoreDynamicTestOAuthAuthorize: (() => void) | undefined;

  beforeEach(() => {
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    mockOAuthEnv();
  });

  afterEach(async () => {
    restoreDynamicTestOAuthAuthorize?.();
    restoreDynamicTestOAuthAuthorize = undefined;

    const db = store.set(writeDb$);
    await db
      .delete(connectorOauthStates)
      .where(
        like(connectorOauthStates.userId, `${AUTH_REQUEST_USER_ID_PREFIX}%`),
      );
    await db
      .delete(connectorSessions)
      .where(like(connectorSessions.userId, `${AUTH_REQUEST_USER_ID_PREFIX}%`));
    while (orgIds.length > 0) {
      const orgId = orgIds.pop();
      if (orgId) {
        await db
          .delete(connectorOauthStates)
          .where(eq(connectorOauthStates.orgId, orgId));
        await db.delete(connectors).where(eq(connectors.orgId, orgId));
        await db.delete(secrets).where(eq(secrets.orgId, orgId));
        await db
          .delete(userFeatureSwitches)
          .where(eq(userFeatureSwitches.orgId, orgId));
      }
    }
  });

  async function requestAuthorizeWithFeature(
    type: string,
    featureKey: FeatureSwitchKey,
  ): Promise<Response> {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    await enableConnectorFeature(userId, orgId, featureKey);
    const sessionId = await createPendingConnectorSession({ userId, type });
    mocks.clerk.session(userId, orgId);
    const app = createApp({ signal: context.signal });
    return await app.request(authorizeUrl(type, sessionId), {
      method: "GET",
      headers: sessionHeaders(),
    });
  }

  it("returns 400 for an unknown connector type", async () => {
    const response = await requestAuthorize("invalid");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Unknown connector type: invalid",
    });
  });

  it("redirects unauthenticated users to sign-in", async () => {
    const sessionId = await createPendingConnectorSession({
      userId: `${AUTH_REQUEST_USER_ID_PREFIX}${randomUUID()}`,
    });
    const response = await requestAuthorize("github", { session: sessionId });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(
      authorizeUrl("github", sessionId, WEB_ORIGIN),
    );
  });

  it("redirects unauthenticated users to sign-in on the web rewrite origin", async () => {
    const sessionId = await createPendingConnectorSession({
      userId: `${AUTH_REQUEST_USER_ID_PREFIX}${randomUUID()}`,
    });
    const response = await requestAuthorize("github", {
      session: sessionId,
      origin: API_ORIGIN,
      headers: {
        "x-vm0-web-origin": WEB_ORIGIN,
      },
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(`${WEB_ORIGIN}/sign-in`);
    expect(url.searchParams.get("redirect_url")).toBe(
      `${WEB_ORIGIN}/api/zero/connectors/github/authorize?session=${sessionId}`,
    );
  });

  it("redirects direct API host authorize requests to the canonical web route", async () => {
    const response = await requestAuthorize("github", {
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${WEB_ORIGIN}/api/zero/connectors/github/authorize`,
    );
  });

  it("redirects to GitHub OAuth and sets the state cookie", async () => {
    const response = await requestAuthorize("github", { authenticated: true });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/github/callback`,
    );
    expect(url.searchParams.get("scope")).toBe("repo project workflow");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith("connector_oauth_state=");
      }),
    ).toBeTruthy();
  });

  it("rejects auth-code OAuth authorization when the connector feature is disabled", async () => {
    const response = await requestAuthorize("test-oauth", {
      authenticated: true,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: "test-oauth connector is not available",
    });
  });

  it("returns 400 when authorizing a device authorization connector", async () => {
    const response = await requestAuthorize("test-oauth-device", {
      authenticated: true,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "test-oauth-device connector does not use an auth-code grant",
    });
  });

  it("sets Secure on OAuth cookies in production", async () => {
    mockEnv("ENV", "production");

    const response = await requestAuthorize("github", { authenticated: true });

    const cookies = response.headers.getSetCookie();
    const stateCookie = cookies.find((cookie) => {
      return cookie.startsWith("connector_oauth_state=");
    });
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain("Secure");
  });

  it("uses the web rewrite origin for OAuth callback URLs", async () => {
    const response = await requestAuthorize("github", {
      authenticated: true,
      origin: API_ORIGIN,
      headers: {
        "x-vm0-web-origin": WEB_ORIGIN,
      },
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/github/callback`,
    );
  });

  it("requests offline Google OAuth access", async () => {
    const response = await requestAuthorize("google-drive", {
      authenticated: true,
    });

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("google-test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/google-drive/callback`,
    );
    const scopes = new Set(url.searchParams.get("scope")?.split(" ") ?? []);
    expect(scopes.has("https://www.googleapis.com/auth/drive")).toBeTruthy();
    expect(
      scopes.has("https://www.googleapis.com/auth/userinfo.email"),
    ).toBeTruthy();
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("stores the connector session id when provided", async () => {
    const userId = `${AUTH_REQUEST_USER_ID_PREFIX}${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const sessionId = await createPendingConnectorSession({ userId });
    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("github", sessionId), {
      method: "GET",
      headers: sessionHeaders(),
    });

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith(`connector_oauth_session=${sessionId}`);
      }),
    ).toBeTruthy();

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const state = new URL(location!).searchParams.get("state");
    expect(state).not.toBeNull();

    const db = store.set(writeDb$);
    const [storedState] = await db
      .select({
        authMethod: connectorOauthStates.authMethod,
        sessionId: connectorOauthStates.sessionId,
      })
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.state, state!));
    expect(storedState).toStrictEqual({
      authMethod: "oauth",
      sessionId,
    });
  });

  it("allows dynamic public OAuth authorize without env credentials", async () => {
    restoreDynamicTestOAuthAuthorize = useDynamicTestOAuthAuthorize();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    await enableConnectorFeature(
      userId,
      orgId,
      FeatureSwitchKey.TestOauthConnector,
    );
    const sessionId = await createPendingConnectorSession({
      userId,
      type: "test-oauth",
    });
    mocks.clerk.session(userId, orgId);

    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("test-oauth", sessionId), {
      method: "GET",
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://dynamic-oauth.test/authorize",
    );
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith(
          "connector_oauth_context=dynamic-oauth-context%3B%20tenant%3Dexample",
        );
      }),
    ).toBeTruthy();
  });

  it("rejects authorization without a pending connector session", async () => {
    const response = await requestAuthorize("github", {
      authenticated: true,
      withSession: false,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid connector session",
    });
  });

  it("uses Slack user_scope rather than scope", async () => {
    const response = await requestAuthorize("slack", { authenticated: true });

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("test-slack-client-id");
    expect(url.searchParams.get("user_scope")).toContain("channels:read");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("includes the Notion owner parameter", async () => {
    const response = await requestAuthorize("notion", { authenticated: true });

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("notion-test-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("owner")).toBe("user");
  });

  it("includes DocuSign PKCE parameters", async () => {
    const response = await requestAuthorizeWithFeature(
      "docusign",
      FeatureSwitchKey.DocuSignConnector,
    );

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://account-d.docusign.com/oauth/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("docusign-test-client-id");
    expect(url.searchParams.get("scope")).toContain("signature");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("requests permanent Reddit authorization", async () => {
    const response = await requestAuthorizeWithFeature(
      "reddit",
      FeatureSwitchKey.RedditConnector,
    );

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.reddit.com/api/v1/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("reddit-test-client-id");
    expect(url.searchParams.get("duration")).toBe("permanent");
    expect(url.searchParams.get("scope")).toBe("identity read");
  });

  it("sets a PKCE verifier cookie for Airtable", async () => {
    const response = await requestAuthorize("airtable", {
      authenticated: true,
    });

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://airtable.com/oauth2/v1/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("airtable-test-client-id");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith("connector_oauth_pkce=");
      }),
    ).toBeTruthy();
  });

  it("requests offline Dropbox authorization", async () => {
    const response = await requestAuthorizeWithFeature(
      "dropbox",
      FeatureSwitchKey.DropboxConnector,
    );

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.dropbox.com/oauth2/authorize",
    );
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("force_reapprove")).toBe("true");
  });

  it("uses Strava comma scopes and forced approval", async () => {
    const response = await requestAuthorize("strava", { authenticated: true });

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.strava.com/oauth/authorize",
    );
    expect(url.searchParams.get("scope")).toBe(
      "read,profile:read_all,activity:read_all,activity:write",
    );
    expect(url.searchParams.get("approval_prompt")).toBe("force");
  });

  it("uses Linear user actor and consent prompt", async () => {
    const response = await requestAuthorize("linear", { authenticated: true });

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://linear.app/oauth/authorize",
    );
    expect(url.searchParams.get("scope")).toBe(
      "read,write,issues:create,comments:create,timeSchedule:write",
    );
    expect(url.searchParams.get("actor")).toBe("user");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("includes X PKCE parameters", async () => {
    const response = await requestAuthorize("x", { authenticated: true });

    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://x.com/i/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("x-test-client-id");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("deletes existing local connector state before reauthorization", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    const db = store.set(writeDb$);
    const [connector] = await db
      .insert(connectors)
      .values({ orgId, userId, type: "github", authMethod: "oauth" })
      .returning({ id: connectors.id });
    expect(connector).toBeDefined();

    const sessionId = await createPendingConnectorSession({ userId });
    mocks.clerk.session(userId, orgId);
    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("github", sessionId), {
      method: "GET",
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(307);
    const survivors = await db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connector!.id));
    expect(survivors).toHaveLength(0);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      null,
    );
  });

  it("keeps existing local connector state when OAuth is not configured", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
    const db = store.set(writeDb$);
    const [connector] = await db
      .insert(connectors)
      .values({ orgId, userId, type: "github", authMethod: "oauth" })
      .returning({ id: connectors.id });
    expect(connector).toBeDefined();

    const sessionId = await createPendingConnectorSession({ userId });
    mocks.clerk.session(userId, orgId);
    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("github", sessionId), {
      method: "GET",
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(500);
    const survivors = await db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connector!.id));
    expect(survivors).toHaveLength(1);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("best-effort revokes GitHub grants before local cleanup", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    const db = store.set(writeDb$);
    const [connector] = await db
      .insert(connectors)
      .values({ orgId, userId, type: "github", authMethod: "oauth" })
      .returning({ id: connectors.id });
    expect(connector).toBeDefined();
    await db.insert(secrets).values({
      orgId,
      userId,
      name: "GITHUB_ACCESS_TOKEN",
      type: "connector",
      encryptedValue: encryptSecretForTests("gh-access-token"),
    });

    let revokeAuthorization: string | null = null;
    let revokeBody = "";
    server.use(
      http.delete(
        "https://api.github.com/applications/test-client-id/grant",
        async ({ request }) => {
          revokeAuthorization = request.headers.get("authorization");
          revokeBody = await request.text();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const sessionId = await createPendingConnectorSession({ userId });
    mocks.clerk.session(userId, orgId);
    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("github", sessionId), {
      method: "GET",
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(307);
    expect(revokeAuthorization).toBe(
      `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`,
    );
    expect(revokeBody).toContain('"access_token":"gh-access-token"');
  });

  it("skips provider revoke for connectors without revoke support", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    const db = store.set(writeDb$);
    const [connector] = await db
      .insert(connectors)
      .values({ orgId, userId, type: "notion", authMethod: "oauth" })
      .returning({ id: connectors.id });
    expect(connector).toBeDefined();
    await db.insert(secrets).values({
      orgId,
      userId,
      name: "NOTION_ACCESS_TOKEN",
      type: "connector",
      encryptedValue: "invalid-encrypted-token",
    });

    let revokeCalled = false;
    server.use(
      http.post("https://api.notion.com/v1/oauth/revoke", () => {
        revokeCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const sessionId = await createPendingConnectorSession({
      userId,
      type: "notion",
    });
    mocks.clerk.session(userId, orgId);
    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("notion", sessionId), {
      method: "GET",
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(307);
    expect(revokeCalled).toBeFalsy();
    const survivors = await db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connector!.id));
    expect(survivors).toHaveLength(0);
    const secretSurvivors = await db
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.name, "NOTION_ACCESS_TOKEN"),
          eq(secrets.type, "connector"),
        ),
      );
    expect(secretSurvivors).toHaveLength(0);
  });
});

describe("POST /api/zero/connectors/:type/oauth/start", () => {
  const orgIds: string[] = [];
  const stateIds: string[] = [];

  beforeEach(() => {
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    mockOAuthEnv();
  });

  afterEach(async () => {
    const db = store.set(writeDb$);
    while (stateIds.length > 0) {
      const stateId = stateIds.pop();
      if (stateId) {
        await db
          .delete(connectorOauthStates)
          .where(eq(connectorOauthStates.id, stateId));
      }
    }
    while (orgIds.length > 0) {
      const orgId = orgIds.pop();
      if (orgId) {
        await db.delete(connectors).where(eq(connectors.orgId, orgId));
        await db.delete(secrets).where(eq(secrets.orgId, orgId));
        await db
          .delete(userFeatureSwitches)
          .where(eq(userFeatureSwitches.orgId, orgId));
      }
    }
  });

  it("rejects auth-code OAuth start when the connector feature is disabled", async () => {
    const response = await requestOauthStart("test-oauth", {
      authenticated: true,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "test-oauth connector is not available",
        code: "FORBIDDEN",
      },
    });
  });

  it("creates a server-side OAuth handoff and returns the provider authorization URL", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    mocks.clerk.session(userId, orgId);

    const response = await requestOauthStart("github", {
      headers: { authorization: "Bearer clerk-session" },
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly authorizationUrl: string;
    };
    const authorizationUrl = new URL(body.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-client-id",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/github/callback`,
    );
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const db = store.set(writeDb$);
    const [storedState] = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.state, state!));
    expect(storedState).toBeDefined();
    stateIds.push(storedState!.id);
    expect(storedState).toMatchObject({
      state,
      type: "github",
      authMethod: "oauth",
      userId,
      orgId,
      redirectUri: `${WEB_ORIGIN}/api/connectors/github/callback`,
      consumedAt: null,
    });
    expect(storedState!.expiresAt.getTime()).toBeGreaterThan(now());
  });

  it("uses the configured web origin for local OAuth callback URLs", async () => {
    mockEnv("VM0_WEB_URL", LOCAL_WEB_ORIGIN);
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    mocks.clerk.session(userId, orgId);

    const response = await requestOauthStart("github", {
      headers: { authorization: "Bearer clerk-session" },
      origin: LOCAL_ORIGIN,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly authorizationUrl: string;
    };
    const authorizationUrl = new URL(body.authorizationUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${LOCAL_WEB_ORIGIN}/api/connectors/github/callback`,
    );
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const db = store.set(writeDb$);
    const [storedState] = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.state, state!));
    expect(storedState).toBeDefined();
    stateIds.push(storedState!.id);
    expect(storedState!.redirectUri).toBe(
      `${LOCAL_WEB_ORIGIN}/api/connectors/github/callback`,
    );
  });

  it("stores provider PKCE context for server-side OAuth handoff", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    mocks.clerk.session(userId, orgId);

    const response = await requestOauthStart("airtable", {
      headers: { authorization: "Bearer clerk-session" },
      origin: API_ORIGIN,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly authorizationUrl: string;
    };
    const authorizationUrl = new URL(body.authorizationUrl);
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
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const db = store.set(writeDb$);
    const [storedState] = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.state, state!));
    expect(storedState).toBeDefined();
    stateIds.push(storedState!.id);
    expect(storedState).toMatchObject({
      state,
      type: "airtable",
      authMethod: "oauth",
      userId,
      orgId,
      redirectUri: `${WEB_ORIGIN}/api/connectors/airtable/callback`,
      consumedAt: null,
    });
    expect(storedState!.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(storedState!.expiresAt.getTime()).toBeGreaterThan(now());
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
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    mocks.clerk.session(userId, orgId);

    const response = await requestOauthStart("test-oauth-device", {
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "test-oauth-device connector does not use an auth-code grant",
        code: "BAD_REQUEST",
      },
    });

    const db = store.set(writeDb$);
    const states = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.userId, userId));
    expect(states).toHaveLength(0);
  });

  it("returns 400 when starting OAuth with a missing selected auth method", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    mocks.clerk.session(userId, orgId);

    const response = await requestOauthStart("github", {
      authMethod: "api-token",
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "github connector does not have api-token auth method",
        code: "BAD_REQUEST",
      },
    });

    const db = store.set(writeDb$);
    const states = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.userId, userId));
    expect(states).toHaveLength(0);
  });

  it("does not create server-side handoff state when OAuth is not configured", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    orgIds.push(orgId);
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
    mocks.clerk.session(userId, orgId);

    const response = await requestOauthStart("github", {
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "github OAuth not configured",
        code: "INTERNAL_SERVER_ERROR",
      },
    });

    const db = store.set(writeDb$);
    const states = await db
      .select()
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.userId, userId));
    expect(states).toHaveLength(0);
  });
});
