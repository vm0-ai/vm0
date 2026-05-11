import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { decryptSecretValue } from "../../services/crypto.utils";
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
) {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(userFeatureSwitches)
    .values({ orgId, userId, switches })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches },
    });
}

async function enableAllPersonalSwitches(orgId: string, userId: string) {
  await setPersonalSwitches(orgId, userId, {
    [FeatureSwitchKey.ModelFirstModelProvider]: true,
    [FeatureSwitchKey.CodexOauthProvider]: true,
  });
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
  const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
    return store.set(deleteUserModelProviders$, fixture, context.signal);
  });

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

  it("returns 404 when ModelFirstModelProvider is off", async () => {
    const fixture = uniqueOrgUser("zmmp-upsert-feature-off");
    await track(Promise.resolve(fixture));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not found", code: "NOT_FOUND" },
    });
  });

  it("creates a single-secret personal provider", async () => {
    const fixture = uniqueOrgUser("zmmp-single-create");
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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
        isDefault: true,
      },
      created: true,
    });

    // DB read-after-write proves encrypt path.
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "CLAUDE_CODE_OAUTH_TOKEN"),
        ),
      );
    expect(decryptSecretValue(row!.encryptedValue)).toBe("sk-ant-test");
  });

  it("updates an existing personal provider with 200", async () => {
    const fixture = uniqueOrgUser("zmmp-single-update");
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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

  it("returns 404 when posting vm0 with a secret", async () => {
    const fixture = uniqueOrgUser("zmmp-vm0-with-secret");
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);

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
        planType: "plus",
        needsReconnect: false,
      },
    });

    // DB read-after-write: 4 derived CHATGPT_* secrets persisted.
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({ name: secrets.name })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
        ),
      );
    const names = new Set(
      rows.map((r) => {
        return r.name;
      }),
    );
    expect(names).toContain("CHATGPT_ACCESS_TOKEN");
    expect(names).toContain("CHATGPT_REFRESH_TOKEN");
    expect(names).toContain("CHATGPT_ACCOUNT_ID");
    expect(names).toContain("CHATGPT_ID_TOKEN");
    // The raw CODEX_AUTH_JSON blob is NEVER persisted.
    expect(names).not.toContain("CODEX_AUTH_JSON");
  });

  it("returns 400 CODEX_AUTH_JSON_SHAPE_INVALID on malformed JSON", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-malformed");
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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
    await track(Promise.resolve(fixture));
    await enableAllPersonalSwitches(fixture.orgId, fixture.userId);
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

  it("returns 404 when CodexOauthProvider feature switch is off", async () => {
    const fixture = uniqueOrgUser("zmmp-codex-gate-off");
    await track(Promise.resolve(fixture));
    await setPersonalSwitches(fixture.orgId, fixture.userId, {
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
      [FeatureSwitchKey.CodexOauthProvider]: false,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

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
      [404],
    );
    expect(response.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "codex-oauth-token" not found',
      },
    });
  });
});

// Cleanup the userFeatureSwitches rows created by this suite — the sibling
// `deleteUserModelProviders$` helper only cleans `model_providers` + `secrets`.
// Without this the userFeatureSwitches table grows unboundedly across runs.
// (Same pattern as the delete sibling test.)
