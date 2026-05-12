import { randomUUID } from "node:crypto";

import { connectors } from "@vm0/db/schema/connector";
import { connectorSessions } from "@vm0/db/schema/connector-session";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { decryptSecretValue } from "../../services/crypto.utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_USER_INFO_URL = "https://slack.com/api/users.info";

function callbackUrl(
  type: string,
  query: Record<string, string | undefined>,
): string {
  const url = new URL(`/api/connectors/${type}/callback`, BASE_URL);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url.toString();
}

function callbackHeaders(args: {
  readonly stateCookie?: string;
  readonly sessionId?: string;
  readonly codeVerifier?: string;
}): HeadersInit {
  const cookies = ["__session=opaque"];
  if (args.stateCookie) {
    cookies.push(`connector_oauth_state=${args.stateCookie}`);
  }
  if (args.sessionId) {
    cookies.push(`connector_oauth_session=${args.sessionId}`);
  }
  if (args.codeVerifier) {
    cookies.push(`connector_oauth_pkce=${args.codeVerifier}`);
  }
  return { cookie: cookies.join("; ") };
}

function authenticate(args: {
  readonly userId: string;
  readonly orgId: string;
}): void {
  mocks.clerk.session(args.userId, args.orgId);
}

async function requestCallback(args: {
  readonly type: string;
  readonly query: Record<string, string | undefined>;
  readonly headers?: HeadersInit;
}): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(callbackUrl(args.type, args.query), {
    method: "GET",
    headers: args.headers,
  });
}

function mockOAuthEnv(): void {
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", "github-client-id");
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "github-client-secret");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-client-secret");
  mockOptionalEnv("SLACK_CLIENT_ID", "slack-client-id");
  mockOptionalEnv("SLACK_CLIENT_SECRET", "slack-client-secret");
}

function mockGitHubOAuth(options: {
  readonly accessToken?: string;
  readonly tokenError?: string;
  readonly userId?: number;
  readonly username?: string;
  readonly email?: string | null;
}): void {
  server.use(
    http.post(GITHUB_TOKEN_URL, () => {
      if (options.tokenError) {
        return HttpResponse.json({
          error: "bad_verification_code",
          error_description: options.tokenError,
        });
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "github-access-token",
        scope: "repo",
        token_type: "bearer",
      });
    }),
    http.get(GITHUB_USER_URL, () => {
      return HttpResponse.json({
        id: options.userId ?? 12_345,
        login: options.username ?? "octocat",
        email: options.email ?? "octocat@example.com",
      });
    }),
  );
}

function mockNotionOAuth(options: {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
}): void {
  server.use(
    http.post(NOTION_TOKEN_URL, () => {
      return HttpResponse.json({
        access_token: options.accessToken ?? "notion-access-token",
        refresh_token: options.refreshToken ?? "notion-refresh-token",
        expires_in: options.expiresIn ?? 7200,
        token_type: "bearer",
        owner: {
          user: {
            id: "notion-user-123",
            name: "Notion User",
            person: {
              email: "notion@example.com",
            },
          },
        },
      });
    }),
  );
}

function mockSlackOAuth(options: { readonly accessToken?: string }): void {
  server.use(
    http.post(SLACK_TOKEN_URL, () => {
      return HttpResponse.json({
        ok: true,
        authed_user: {
          id: "U012AB3CD",
          access_token: options.accessToken ?? "xoxp-user-token",
          scope: "channels:read,channels:history,chat:write",
        },
      });
    }),
    http.get(SLACK_USER_INFO_URL, () => {
      return HttpResponse.json({
        ok: true,
        user: {
          id: "U012AB3CD",
          name: "slackuser",
          real_name: "Slack User",
          profile: {
            email: "slack@example.com",
          },
        },
      });
    }),
  );
}

async function seedSession(userId: string): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(connectorSessions)
    .values({
      code: randomUUID().slice(0, 9).toUpperCase(),
      type: "github",
      userId,
      status: "pending",
      expiresAt: new Date(now() + 15 * 60 * 1000),
    })
    .returning({ id: connectorSessions.id });
  expect(session).toBeDefined();
  return session!.id;
}

async function findConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}) {
  const db = store.set(writeDb$);
  const [connector] = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.type, args.type),
      ),
    );
  return connector;
}

async function findSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}) {
  const db = store.set(writeDb$);
  const [secret] = await db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, args.name),
        eq(secrets.type, "connector"),
      ),
    );
  return secret;
}

describe("GET /api/connectors/:type/callback", () => {
  const orgIds: string[] = [];
  const sessionIds: string[] = [];

  beforeEach(() => {
    mockOAuthEnv();
  });

  afterEach(async () => {
    const db = store.set(writeDb$);
    while (orgIds.length > 0) {
      const orgId = orgIds.pop();
      if (orgId) {
        await db.delete(connectors).where(eq(connectors.orgId, orgId));
        await db.delete(secrets).where(eq(secrets.orgId, orgId));
      }
    }
    while (sessionIds.length > 0) {
      const sessionId = sessionIds.pop();
      if (sessionId) {
        await db
          .delete(connectorSessions)
          .where(eq(connectorSessions.id, sessionId));
      }
    }
  });

  it("redirects unauthenticated users to the connector error page", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("type")).toBe("github");
    expect(url.searchParams.get("message")).toBe("Not authenticated");
  });

  it("rejects state mismatch and clears OAuth cookies", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "returned-state" },
      headers: callbackHeaders({ stateCookie: "saved-state" }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe(
      "Invalid state - please try again",
    );
    const cookies = response.headers.getSetCookie();
    expect(cookies).toStrictEqual(
      expect.arrayContaining([
        "connector_oauth_state=; Max-Age=0; Path=/",
        "connector_oauth_session=; Max-Age=0; Path=/",
        "connector_oauth_pkce=; Max-Age=0; Path=/",
      ]),
    );
  });

  it("stores a GitHub OAuth connector and completes the CLI session", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    const sessionId = await seedSession(userId);
    sessionIds.push(sessionId);
    mockGitHubOAuth({
      accessToken: "github-token",
      userId: 98_765,
      username: "octocat",
      email: "octocat@example.com",
    });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({
        stateCookie: "state-123",
        sessionId,
      }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/success");
    expect(url.searchParams.get("type")).toBe("github");
    expect(url.searchParams.get("username")).toBe("octocat");
    expect(response.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([
        "connector_oauth_state=; Max-Age=0; Path=/",
        "connector_oauth_session=; Max-Age=0; Path=/",
        "connector_oauth_pkce=; Max-Age=0; Path=/",
      ]),
    );

    const connector = await findConnector({ orgId, userId, type: "github" });
    expect(connector).toMatchObject({
      type: "github",
      authMethod: "oauth",
      externalId: "98765",
      externalUsername: "octocat",
      externalEmail: "octocat@example.com",
      needsReconnect: false,
    });
    expect(connector?.oauthScopes).toBe(
      JSON.stringify(["repo", "project", "workflow"]),
    );
    expect(connector?.tokenExpiresAt).toBeNull();

    const secret = await findSecret({
      orgId,
      userId,
      name: "GITHUB_ACCESS_TOKEN",
    });
    expect(secret).toBeDefined();
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("github-token");

    const db = store.set(writeDb$);
    const [session] = await db
      .select()
      .from(connectorSessions)
      .where(eq(connectorSessions.id, sessionId));
    expect(session?.status).toBe("complete");
    expect(session?.completedAt).toBeInstanceOf(Date);
  });

  it("stores a Slack user OAuth token without an expiry", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    mockSlackOAuth({ accessToken: "xoxp-stored-token" });

    const response = await requestCallback({
      type: "slack",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const connector = await findConnector({ orgId, userId, type: "slack" });
    expect(connector).toMatchObject({
      type: "slack",
      authMethod: "oauth",
      externalId: "U012AB3CD",
      externalUsername: "Slack User",
      externalEmail: "slack@example.com",
    });
    expect(connector?.tokenExpiresAt).toBeNull();

    const secret = await findSecret({
      orgId,
      userId,
      name: "SLACK_ACCESS_TOKEN",
    });
    expect(secret).toBeDefined();
    expect(decryptSecretValue(secret!.encryptedValue)).toBe(
      "xoxp-stored-token",
    );
  });

  it("stores a Notion refresh token and access-token expiry", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    mockNotionOAuth({
      accessToken: "notion-access",
      refreshToken: "notion-refresh",
      expiresIn: 7200,
    });

    const response = await requestCallback({
      type: "notion",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123" }),
    });

    expect(response.status).toBe(307);
    const connector = await findConnector({ orgId, userId, type: "notion" });
    expect(connector).toMatchObject({
      type: "notion",
      authMethod: "oauth",
      externalId: "notion-user-123",
      externalUsername: "Notion User",
      externalEmail: "notion@example.com",
    });
    expect(connector?.tokenExpiresAt).toBeInstanceOf(Date);
    expect(connector!.tokenExpiresAt!.getTime()).toBeGreaterThan(now());

    const accessSecret = await findSecret({
      orgId,
      userId,
      name: "NOTION_ACCESS_TOKEN",
    });
    const refreshSecret = await findSecret({
      orgId,
      userId,
      name: "NOTION_REFRESH_TOKEN",
    });
    expect(accessSecret).toBeDefined();
    expect(refreshSecret).toBeDefined();
    expect(decryptSecretValue(accessSecret!.encryptedValue)).toBe(
      "notion-access",
    );
    expect(decryptSecretValue(refreshSecret!.encryptedValue)).toBe(
      "notion-refresh",
    );
  });

  it("marks CLI sessions as error when token exchange fails", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    orgIds.push(orgId);
    authenticate({ userId, orgId });
    const sessionId = await seedSession(userId);
    sessionIds.push(sessionId);
    mockGitHubOAuth({ tokenError: "bad code" });

    const response = await requestCallback({
      type: "github",
      query: { code: "code-123", state: "state-123" },
      headers: callbackHeaders({ stateCookie: "state-123", sessionId }),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe(
      "OAuth authorization failed. Please try again.",
    );

    const db = store.set(writeDb$);
    const [session] = await db
      .select()
      .from(connectorSessions)
      .where(eq(connectorSessions.id, sessionId));
    expect(session?.status).toBe("error");
    expect(session?.errorMessage).toBe("bad code");
  });
});
