import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
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

async function requestAuthorizeWithFeature(
  type: string,
  featureKey: FeatureSwitchKey,
): Promise<Response> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [featureKey]: true },
  });
  mocks.clerk.session(userId, orgId);
  const app = createApp({ signal: context.signal });
  const response = await app.request(authorizeUrl(type), {
    method: "GET",
    headers: sessionHeaders(),
  });
  await db
    .delete(userFeatureSwitches)
    .where(eq(userFeatureSwitches.orgId, orgId));
  return response;
}

describe("GET /api/connectors/:type/authorize", () => {
  beforeEach(() => {
    mockEnv("VM0_WEB_URL", BASE_URL);
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
    mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "test-slack-client-secret");
    mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-test-client-id");
    mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-test-client-secret");
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

  it("rejects feature-disabled direct OAuth authorization", async () => {
    const response = await requestAuthorize("docusign", {
      authenticated: true,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: "docusign connector is not available",
    });
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
    const response = await requestAuthorizeWithFeature(
      "docusign",
      FeatureSwitchKey.DocuSignConnector,
    );

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
    const response = await requestAuthorizeWithFeature(
      "mercury",
      FeatureSwitchKey.MercuryConnector,
    );

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
    const response = await requestAuthorizeWithFeature(
      "reddit",
      FeatureSwitchKey.RedditConnector,
    );

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
      "https://x.com/i/oauth2/authorize",
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
