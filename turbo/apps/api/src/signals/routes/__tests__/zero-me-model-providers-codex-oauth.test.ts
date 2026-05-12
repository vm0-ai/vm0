import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";

import { createApp } from "../../../app-factory";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteUserModelProviders$,
  type UserModelProviderFixture,
} from "./helpers/zero-model-providers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function authorizeUrl(): string {
  return `${BASE_URL}/api/zero/me/model-providers/codex-oauth-token/oauth/authorize`;
}

function callbackUrl(query: string): string {
  return `${BASE_URL}/api/zero/me/model-providers/codex-oauth-token/oauth/callback?${query}`;
}

function sessionHeaders(cookie = "__session=opaque"): HeadersInit {
  return { cookie };
}

function uniqueOrgUser(prefix: string): UserModelProviderFixture {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

async function setPersonalSwitches(
  orgId: string,
  userId: string,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(userFeatureSwitches)
    .values({ orgId, userId, switches })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches },
    });
}

async function enableAllPersonalSwitches(
  orgId: string,
  userId: string,
): Promise<void> {
  await setPersonalSwitches(orgId, userId, {
    [FeatureSwitchKey.ModelFirstModelProvider]: true,
    [FeatureSwitchKey.CodexOauthProvider]: true,
  });
}

async function deletePersonalSwitches(
  fixture: UserModelProviderFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createJwt(payload: Record<string, unknown>): string {
  return [
    base64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64Url(JSON.stringify(payload)),
    "",
  ].join(".");
}

describe("GET /api/zero/me/model-providers/codex-oauth-token/oauth", () => {
  const track = createFixtureTracker<UserModelProviderFixture>(
    async (fixture) => {
      await store.set(deleteUserModelProviders$, fixture, context.signal);
      await deletePersonalSwitches(fixture);
    },
  );

  it("redirects authorize requests from unauthenticated users to sign-in", async () => {
    const app = createApp({ signal: context.signal });

    const response = await app.request(authorizeUrl(), { method: "GET" });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(authorizeUrl());
  });

  it("returns 404 from authorize when Codex OAuth is disabled", async () => {
    const fixture = await track(
      Promise.resolve(uniqueOrgUser("codex-oauth-authz-off")),
    );
    await setPersonalSwitches(fixture.orgId, fixture.userId, {
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
      [FeatureSwitchKey.CodexOauthProvider]: false,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createApp({ signal: context.signal });

    const response = await app.request(authorizeUrl(), {
      method: "GET",
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Not found",
    });
  });

  it("redirects authorize to OpenAI OAuth with state and PKCE cookies", async () => {
    const fixture = await track(
      Promise.resolve(uniqueOrgUser("codex-oauth-authz")),
    );
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createApp({ signal: context.signal });

    const response = await app.request(authorizeUrl(), {
      method: "GET",
      headers: sessionHeaders(),
    });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://auth.openai.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/api/zero/me/model-providers/codex-oauth-token/oauth/callback`,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith("model_provider_oauth_state=");
      }),
    ).toBeTruthy();
    expect(
      cookies.some((cookie) => {
        return cookie.startsWith("model_provider_oauth_pkce=");
      }),
    ).toBeTruthy();
  });

  it("rejects callback mismatched state and clears OAuth cookies", async () => {
    const fixture = await track(
      Promise.resolve(uniqueOrgUser("codex-oauth-state")),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      callbackUrl("code=code-1&state=wrong-state"),
      {
        method: "GET",
        headers: sessionHeaders(
          "__session=opaque; model_provider_oauth_state=expected-state; model_provider_oauth_pkce=verifier-1",
        ),
      },
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toContain("Invalid state");
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.find((cookie) => {
        return cookie.startsWith("model_provider_oauth_state=;");
      }),
    ).toContain("Max-Age=0");
    expect(
      cookies.find((cookie) => {
        return cookie.startsWith("model_provider_oauth_pkce=;");
      }),
    ).toContain("Max-Age=0");
  });

  it("exchanges callback code and persists the personal ChatGPT provider", async () => {
    const fixture = await track(
      Promise.resolve(uniqueOrgUser("codex-oauth-callback")),
    );
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const accessToken = createJwt({ exp: 1_900_000_000 });
    const idToken = createJwt({
      sub: "user-1",
      email: "user@example.com",
      name: "Test User",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "plus",
        workspace: { name: "Personal Workspace" },
      },
    });
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.client_id).toBe(CODEX_CLIENT_ID);
        expect(body.grant_type).toBe("authorization_code");
        expect(body.code).toBe("code-1");
        expect(body.redirect_uri).toBe(
          `${BASE_URL}/api/zero/me/model-providers/codex-oauth-token/oauth/callback`,
        );
        expect(body.code_verifier).toBe("verifier-1");
        return HttpResponse.json({
          access_token: accessToken,
          refresh_token: "refresh-1",
          id_token: idToken,
          expires_in: 3600,
        });
      }),
    );
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      callbackUrl("code=code-1&state=state-1"),
      {
        method: "GET",
        headers: sessionHeaders(
          "__session=opaque; model_provider_oauth_state=state-1; model_provider_oauth_pkce=verifier-1",
        ),
      },
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/success");
    expect(url.searchParams.get("type")).toBe("openai");
    expect(url.searchParams.get("username")).toBe("Personal Workspace");
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.find((cookie) => {
        return cookie.startsWith("model_provider_oauth_state=;");
      }),
    ).toContain("Max-Age=0");
    expect(
      cookies.find((cookie) => {
        return cookie.startsWith("model_provider_oauth_pkce=;");
      }),
    ).toContain("Max-Age=0");

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const listResponse = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listResponse.body.modelProviders).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "codex-oauth-token",
          authMethod: "oauth",
          workspaceName: "Personal Workspace",
          planType: "plus",
          needsReconnect: false,
        }),
      ]),
    );
  });

  it("redirects callback with an error when Codex OAuth is disabled", async () => {
    const fixture = await track(
      Promise.resolve(uniqueOrgUser("codex-oauth-callback-off")),
    );
    await setPersonalSwitches(fixture.orgId, fixture.userId, {
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
      [FeatureSwitchKey.CodexOauthProvider]: false,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      callbackUrl("code=code-1&state=state-1"),
      {
        method: "GET",
        headers: sessionHeaders(
          "__session=opaque; model_provider_oauth_state=state-1; model_provider_oauth_pkce=verifier-1",
        ),
      },
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/connector/error");
    expect(url.searchParams.get("message")).toBe(
      "OpenAI OAuth is not available",
    );
  });
});
