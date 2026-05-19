import { randomUUID } from "node:crypto";

import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { encryptSecretValue } from "../../services/crypto.utils";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { testContext } from "../../../__tests__/test-helpers";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";

function authorizeUrl(type: string, session?: string): string {
  const url = new URL(`/api/zero/connectors/${type}/authorize`, BASE_URL);
  if (session) {
    url.searchParams.set("session", session);
  }
  return url.toString();
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
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_ID", "linear-test-client-id");
  mockOptionalEnv("LINEAR_OAUTH_CLIENT_SECRET", "linear-test-client-secret");
  mockOptionalEnv("MERCURY_OAUTH_CLIENT_ID", "mercury-test-client-id");
  mockOptionalEnv("MERCURY_OAUTH_CLIENT_SECRET", "mercury-test-client-secret");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-test-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-test-client-secret");
  mockOptionalEnv("REDDIT_OAUTH_CLIENT_ID", "reddit-test-client-id");
  mockOptionalEnv("REDDIT_OAUTH_CLIENT_SECRET", "reddit-test-client-secret");
  mockOptionalEnv("SLACK_CLIENT_ID", "test-slack-client-id");
  mockOptionalEnv("SLACK_CLIENT_SECRET", "test-slack-client-secret");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_ID", "strava-test-client-id");
  mockOptionalEnv("STRAVA_OAUTH_CLIENT_SECRET", "strava-test-client-secret");
  mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
  mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
}

async function requestAuthorize(
  type: string,
  options: { readonly session?: string; readonly authenticated?: boolean } = {},
): Promise<Response> {
  if (options.authenticated) {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  }
  const app = createApp({ signal: context.signal });
  return await app.request(authorizeUrl(type, options.session), {
    method: "GET",
    headers: options.authenticated ? sessionHeaders() : undefined,
  });
}

describe("GET /api/zero/connectors/:type/authorize", () => {
  const orgIds: string[] = [];

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
  });

  it("returns 400 for an unknown connector type", async () => {
    const response = await requestAuthorize("invalid");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Unknown connector type: invalid",
    });
  });

  it("redirects unauthenticated users to sign-in", async () => {
    const response = await requestAuthorize("github");

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(authorizeUrl("github"));
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
      `${BASE_URL}/api/connectors/github/callback`,
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

  it("stores the connector session id when provided", async () => {
    const response = await requestAuthorize("github", {
      authenticated: true,
      session: "session-123",
    });

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith("connector_oauth_session=session-123");
      }),
    ).toBeTruthy();
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
    const response = await requestAuthorize("docusign", {
      authenticated: true,
    });

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
    const response = await requestAuthorize("reddit", { authenticated: true });

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
    const response = await requestAuthorize("dropbox", {
      authenticated: true,
    });

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
      "https://twitter.com/i/oauth2/authorize",
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

    mocks.clerk.session(userId, orgId);
    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("github"), {
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

    mocks.clerk.session(userId, orgId);
    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("github"), {
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
      encryptedValue: encryptSecretValue("gh-access-token"),
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

    mocks.clerk.session(userId, orgId);
    const app = createApp({ signal: context.signal });
    const response = await app.request(authorizeUrl("github"), {
      method: "GET",
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(307);
    expect(revokeAuthorization).toBe(
      `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`,
    );
    expect(revokeBody).toContain('"access_token":"gh-access-token"');
  });
});
