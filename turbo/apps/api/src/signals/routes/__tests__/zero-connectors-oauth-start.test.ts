import { randomUUID } from "node:crypto";

import type { ConnectorAuthMethodId } from "@vm0/connectors/connectors";
import { connectors } from "@vm0/db/schema/connector";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { testContext } from "../../../__tests__/test-helpers";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";
const API_ORIGIN = "https://api.vm0.ai";
const WEB_ORIGIN = "https://www.vm0.ai";
const LOCAL_ORIGIN = "http://localhost:3000";
const LOCAL_WEB_ORIGIN = "https://www.vm0.ai:8443";
const AUTH_REQUEST_USER_ID_PREFIX = "user_zero_connectors_oauth_start_";

function oauthStartUrl(type: string, origin = BASE_URL): string {
  return new URL(`/api/zero/connectors/${type}/oauth/start`, origin).toString();
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

  it("does not create server-side handoff state when auth client is not configured", async () => {
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
        message: "github auth client not configured",
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
