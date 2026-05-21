import { randomUUID } from "node:crypto";

import { connectorSessions } from "@vm0/db/schema/connector-session";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";

function authorizeUrl(type: string, session?: string): string {
  const url = new URL(`/api/connectors/${type}/authorize`, BASE_URL);
  if (session) {
    url.searchParams.set("session", session);
  }
  return url.toString();
}

function sessionHeaders(): HeadersInit {
  return { cookie: "__session=opaque" };
}

async function requestAuthorize(
  type: string,
  options: {
    readonly session?: string;
    readonly authenticated?: boolean;
    readonly userId?: string;
    readonly orgId?: string;
  } = {},
): Promise<Response> {
  if (options.authenticated) {
    mocks.clerk.session(
      options.userId ?? `user_${randomUUID()}`,
      options.orgId ?? `org_${randomUUID()}`,
    );
  }
  const app = createApp({ signal: context.signal });
  return await app.request(authorizeUrl(type, options.session), {
    method: "GET",
    headers: options.authenticated ? sessionHeaders() : undefined,
  });
}

async function createPendingConnectorSession(args: {
  readonly userId: string;
  readonly type?: string;
}): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(connectorSessions)
    .values({
      code: randomUUID().slice(0, 9).toUpperCase(),
      type: args.type ?? "github",
      userId: args.userId,
      status: "pending",
      expiresAt: new Date(now() + 15 * 60 * 1000),
    })
    .returning({ id: connectorSessions.id });
  expect(session).toBeDefined();
  return session!.id;
}

describe("GET /api/connectors/:type/authorize", () => {
  const sessionIds: string[] = [];

  beforeEach(() => {
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
    mockOptionalEnv("DOCUSIGN_OAUTH_CLIENT_ID", "docusign-test-client-id");
    mockOptionalEnv(
      "DOCUSIGN_OAUTH_CLIENT_SECRET",
      "docusign-test-client-secret",
    );
    mockOptionalEnv("MERCURY_OAUTH_CLIENT_ID", "mercury-test-client-id");
    mockOptionalEnv(
      "MERCURY_OAUTH_CLIENT_SECRET",
      "mercury-test-client-secret",
    );
    mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
    mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
    mockOptionalEnv("REDDIT_OAUTH_CLIENT_ID", "reddit-test-client-id");
    mockOptionalEnv("REDDIT_OAUTH_CLIENT_SECRET", "reddit-test-client-secret");
    mockOptionalEnv("SLACK_CLIENT_ID", "test-slack-client-id");
    mockOptionalEnv("SLACK_CLIENT_SECRET", "test-slack-client-secret");
    mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
    mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
  });

  afterEach(async () => {
    const db = store.set(writeDb$);
    while (sessionIds.length > 0) {
      const sessionId = sessionIds.pop();
      if (sessionId) {
        await db
          .delete(connectorSessions)
          .where(eq(connectorSessions.id, sessionId));
      }
    }
  });

  it("returns 400 for an unknown connector type", async () => {
    const response = await requestAuthorize("invalid");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Unknown connector type: invalid",
    });
  });

  it("redirects unauthenticated users to sign-in with the direct route", async () => {
    const response = await requestAuthorize("github");

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(authorizeUrl("github"));
  });

  it("redirects to GitHub OAuth with the direct callback URI", async () => {
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
      `${BASE_URL}/api/connectors/github/callback`,
    );
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(
      response.headers.getSetCookie().some((cookie) => {
        return cookie.startsWith("connector_oauth_state=");
      }),
    ).toBeTruthy();
  });

  it("sets the state cookie attributes", async () => {
    const response = await requestAuthorize("github", { authenticated: true });

    const cookies = response.headers.getSetCookie();
    const stateCookie = cookies.find((cookie) => {
      return cookie.startsWith("connector_oauth_state=");
    });
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=Lax");
  });

  it("stores the connector session id when provided", async () => {
    const userId = `user_${randomUUID()}`;
    const sessionId = await createPendingConnectorSession({ userId });
    sessionIds.push(sessionId);
    const response = await requestAuthorize("github", {
      authenticated: true,
      userId,
      session: sessionId,
    });

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith(`connector_oauth_session=${sessionId}`);
      }),
    ).toBeTruthy();
  });

  it("rejects invalid connector session ids", async () => {
    const response = await requestAuthorize("github", {
      authenticated: true,
      session: "not-a-session-id",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid connector session",
    });
  });

  it("does not set a session cookie when the query parameter is absent", async () => {
    const response = await requestAuthorize("github", { authenticated: true });

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith("connector_oauth_session=");
      }),
    ).toBeFalsy();
  });

  it("uses Slack user_scope rather than scope", async () => {
    const response = await requestAuthorize("slack", { authenticated: true });

    expect(response.status).toBe(307);
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

  it("includes DocuSign OAuth parameters", async () => {
    const response = await requestAuthorize("docusign", {
      authenticated: true,
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://account-d.docusign.com/oauth/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("docusign-test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/api/connectors/docusign/callback`,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("signature");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes Mercury OAuth parameters", async () => {
    const response = await requestAuthorize("mercury", {
      authenticated: true,
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://oauth2.mercury.com/oauth2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("mercury-test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/api/connectors/mercury/callback`,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("offline_access");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes the Notion owner parameter", async () => {
    const response = await requestAuthorize("notion", { authenticated: true });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("notion-test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/api/connectors/notion/callback`,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requests permanent Reddit authorization", async () => {
    const response = await requestAuthorize("reddit", { authenticated: true });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.reddit.com/api/v1/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("reddit-test-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("identity read");
    expect(url.searchParams.get("duration")).toBe("permanent");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes X PKCE parameters", async () => {
    const response = await requestAuthorize("x", { authenticated: true });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://twitter.com/i/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("x-test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/api/connectors/x/callback`,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
  });
});
