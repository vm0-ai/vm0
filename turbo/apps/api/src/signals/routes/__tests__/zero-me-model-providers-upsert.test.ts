import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { now } from "../../../lib/time";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface UserModelProviderFixture {
  readonly orgId: string;
  readonly userId: string;
}

function uniqueOrgUser(prefix: string): UserModelProviderFixture {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

// ===========================================================================
// JWT helpers ported inline from web's test file (apps/web/app/api/zero/me/
// model-providers/__tests__/route.test.ts:417-466). Used by codex-oauth tests.
// ===========================================================================

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

function makeIdToken(opts: {
  accountId: string;
  planType: string;
  workspaceName?: string;
}): string {
  const auth: Record<string, unknown> = {
    chatgpt_account_id: opts.accountId,
    chatgpt_plan_type: opts.planType,
  };
  if (opts.workspaceName !== undefined) {
    auth.organization = { title: opts.workspaceName };
  }
  return makeJwt({
    "https://api.openai.com/auth": auth,
    exp: Math.floor(now() / 1000) + 3600,
  });
}

function makeAuthJson(overrides?: { planType?: string }): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: makeJwt({ exp: accessExp }),
      refresh_token: "rt_personal_synthetic_high_entropy",
      account_id: "ws_acct_plain",
      id_token: makeIdToken({
        accountId: "ws_acct_from_id_token_personal",
        planType: overrides?.planType ?? "plus",
        workspaceName: "Personal Acme",
      }),
    },
  });
}

describe("POST /api/zero/me/model-providers (upsert)", () => {
  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("creates a single-secret personal provider", async () => {
    const fixture = uniqueOrgUser("zmmp-single-create");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(response.body).toMatchObject({
      provider: {
        type: "claude-code-oauth-token",
        framework: "claude-code",
        isDefault: false,
      },
      created: true,
    });
  });

  it("updates an existing personal provider with 200", async () => {
    const fixture = uniqueOrgUser("zmmp-single-update");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "first" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    const response = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "second" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toMatchObject({ created: false });
  });

  it("returns 400 when single-secret provider is missing the secret", async () => {
    const fixture = uniqueOrgUser("zmmp-missing-secret");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("returns 404 for anthropic-api-key", async () => {
    const fixture = uniqueOrgUser("zmmp-anthropic-rejected");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "anthropic-api-key" not found',
      },
    });
  });

  it("returns 404 when posting vm0 with a secret", async () => {
    const fixture = uniqueOrgUser("zmmp-vm0-with-secret");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: { type: "vm0", secret: "any-value" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 404 when posting vm0 with no secret", async () => {
    const fixture = uniqueOrgUser("zmmp-vm0-no-secret");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: { type: "vm0" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 404 for openai-api-key", async () => {
    const fixture = uniqueOrgUser("zmmp-openai-rejected");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: {
          type: "openai-api-key",
          secret: "sk-proj-test",
          selectedModel: "gpt-5.5",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "openai-api-key" not found',
      },
    });
  });

  it("paste valid auth.json persists derived secrets + metadata", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-happy");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        expect(request.headers.get("chatgpt-account-id")).toBe(
          "ws_acct_from_id_token_personal",
        );
        return HttpResponse.json({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 18_000,
              reset_at: 1_893_441_600,
              used_percent: 25,
            },
            secondary_window: {
              limit_window_seconds: 604_800,
              reset_at: 1_893_456_000,
              used_percent: 40,
            },
          },
        });
      }),
    );

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(response.body).toMatchObject({
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Personal Acme",
        planType: "pro",
        subscriptionResetPeriod: "weekly",
        subscriptionNextResetAt: "2030-01-01T00:00:00.000Z",
        needsReconnect: false,
      },
    });

    const listed = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listed.body.modelProviders).toHaveLength(1);
    expect(listed.body.modelProviders[0]).toMatchObject({
      type: "codex-oauth-token",
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 25,
          remainingPercent: 75,
          resetAt: "2029-12-31T20:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 40,
          remainingPercent: 60,
          resetAt: "2030-01-01T00:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
    });
  });

  it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID on malformed JSON", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-malformed");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: "{ not json" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "CODEX_AUTH_JSON_SHAPE_INVALID" },
    });
  });

  it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID when tokens.refresh_token missing", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-missing-rt");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const incomplete = JSON.stringify({
      tokens: {
        access_token: makeJwt({ exp: now() }),
        // refresh_token omitted
        account_id: "ws_acct",
        id_token: makeIdToken({ accountId: "ws_acct", planType: "plus" }),
      },
    });

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: incomplete },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "CODEX_AUTH_JSON_SHAPE_INVALID" },
    });
  });

  it("returns 400 CODEX_FREE_PLAN_REJECTED for free-plan accounts", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-free");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson({ planType: "free" }) },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "CODEX_FREE_PLAN_REJECTED" },
    });
  });

  it("returns 400 BAD_REQUEST when CODEX_AUTH_JSON is missing from secrets", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-no-blob");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {},
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});
