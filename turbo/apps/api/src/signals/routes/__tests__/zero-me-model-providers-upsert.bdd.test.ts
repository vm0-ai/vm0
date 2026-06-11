import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { secrets } from "@vm0/db/schema/secret";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { decryptStoredSecretValue } from "../../services/crypto.utils";
import {
  deleteUserModelProviders$,
  type UserModelProviderFixture,
} from "./helpers/zero-model-providers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-me-model-providers-upsert.test.ts`. The 14 legacy
// `it()`s collapse into 4 BDD `it()`s: (1) auth chain
// (401 unauthenticated → 401 authenticated session has no
// organization), (2) single-secret provider chain (201
// creates a `claude-code-oauth-token` with the expected
// response shape + encrypted secret → 200 updates an
// existing provider → 400 missing secret → 404 rejects
// `anthropic-api-key` + `vm0` (with/without secret) +
// `openai-api-key`), (3) codex auth_json happy path
// (201 persists 4 derived CHATGPT_* secrets + omits the
// raw blob), (4) codex auth_json validation chain (400
// malformed JSON → 400 missing refresh_token → 400 free
// plan rejected → 400 missing CODEX_AUTH_JSON blob).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

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

describe("BDD POST /api/zero/me/model-providers (upsert) — auth chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 authenticated session has no organization", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      setupApp({ context })(zeroPersonalModelProvidersMainContract).upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: a Clerk session with no organization.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      setupApp({ context })(zeroPersonalModelProvidersMainContract).upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(noOrg.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

describe("BDD POST /api/zero/me/model-providers (upsert) — single-secret chain", () => {
  const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
    return store.set(deleteUserModelProviders$, fixture, context.signal);
  });

  it("gwt-wt-wt: 201 creates a claude-code-oauth-token with encrypted secret → 200 updates an existing provider → 400 missing secret → 404 rejects anthropic-api-key, vm0 (with/without secret), openai-api-key", async () => {
    // Given: a fresh fixture.
    const createFixture = uniqueOrgUser("zmmp-single-create");
    await track(Promise.resolve(createFixture));
    mocks.clerk.session(createFixture.userId, createFixture.orgId);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );

    // When + Then: 201 — a single-secret provider is
    // created with the expected shape + the secret is
    // stored encrypted.
    const created = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      provider: {
        type: "claude-code-oauth-token",
        framework: "claude-code",
        isDefault: false,
      },
      created: true,
    });
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, createFixture.orgId),
          eq(secrets.userId, createFixture.userId),
          eq(secrets.name, "CLAUDE_CODE_OAUTH_TOKEN"),
        ),
      );
    await expect(decryptStoredSecretValue(row!.encryptedValue)).resolves.toBe(
      "sk-ant-test",
    );

    // Given: the same fixture.
    // When + Then: 200 — the second upsert updates
    // (created: false).
    const updateResponse = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "second" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(updateResponse.body).toMatchObject({ created: false });

    // Given: a fresh fixture + a body with no `secret`.
    const missingSecretFixture = uniqueOrgUser("zmmp-missing-secret");
    await track(Promise.resolve(missingSecretFixture));
    mocks.clerk.session(
      missingSecretFixture.userId,
      missingSecretFixture.orgId,
    );

    // When + Then: 400 — missing `secret` for a
    // single-secret provider.
    const missingSecretResponse = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(missingSecretResponse.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    // Given: a fresh fixture + an unsupported provider
    // type `anthropic-api-key`.
    const anthropicFixture = uniqueOrgUser("zmmp-anthropic-rejected");
    await track(Promise.resolve(anthropicFixture));
    mocks.clerk.session(anthropicFixture.userId, anthropicFixture.orgId);

    // When + Then: 404 — anthropic-api-key is not a
    // registered personal provider.
    const anthropicResponse = await accept(
      client.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(anthropicResponse.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "anthropic-api-key" not found',
      },
    });

    // Given: a fresh fixture + `vm0` with a secret.
    const vm0WithSecretFixture = uniqueOrgUser("zmmp-vm0-with-secret");
    await track(Promise.resolve(vm0WithSecretFixture));
    mocks.clerk.session(
      vm0WithSecretFixture.userId,
      vm0WithSecretFixture.orgId,
    );

    // When + Then: 404 — `vm0` is not a registered
    // personal provider.
    const vm0WithSecretResponse = await accept(
      client.upsert({
        body: { type: "vm0", secret: "any-value" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(vm0WithSecretResponse.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Given: a fresh fixture + `vm0` without a secret.
    const vm0NoSecretFixture = uniqueOrgUser("zmmp-vm0-no-secret");
    await track(Promise.resolve(vm0NoSecretFixture));
    mocks.clerk.session(vm0NoSecretFixture.userId, vm0NoSecretFixture.orgId);

    // When + Then: 404 — `vm0` is not a registered
    // personal provider, even with no secret.
    const vm0NoSecretResponse = await accept(
      client.upsert({
        body: { type: "vm0" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(vm0NoSecretResponse.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Given: a fresh fixture + an unsupported provider
    // type `openai-api-key`.
    const openaiFixture = uniqueOrgUser("zmmp-openai-rejected");
    await track(Promise.resolve(openaiFixture));
    mocks.clerk.session(openaiFixture.userId, openaiFixture.orgId);

    // When + Then: 404 — openai-api-key is not a
    // registered personal provider.
    const openaiResponse = await accept(
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
    expect(openaiResponse.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "openai-api-key" not found',
      },
    });
  });
});

describe("BDD POST /api/zero/me/model-providers (upsert) — codex auth_json happy path", () => {
  const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
    return store.set(deleteUserModelProviders$, fixture, context.signal);
  });

  it("gwt-wt-wt: 201 pastes valid auth.json and persists 4 derived CHATGPT_* secrets without leaking the raw blob", async () => {
    // Given: a fresh fixture.
    const fixture = uniqueOrgUser("zmmp-codex-happy");
    await track(Promise.resolve(fixture));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );

    // When + Then: 201 — the response carries the
    // workspace + plan metadata.
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

    // Then: 4 derived CHATGPT_* secrets are persisted +
    // the raw CODEX_AUTH_JSON blob is NOT persisted.
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
    expect(names).not.toContain("CODEX_AUTH_JSON");
  });
});

describe("BDD POST /api/zero/me/model-providers (upsert) — codex auth_json validation chain", () => {
  const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
    return store.set(deleteUserModelProviders$, fixture, context.signal);
  });

  it("gwt-wt-wt: 400 malformed JSON → 400 missing refresh_token → 400 free plan rejected → 400 missing CODEX_AUTH_JSON blob", async () => {
    // Given: a fresh fixture + a malformed JSON blob.
    const malformedFixture = uniqueOrgUser("zmmp-codex-malformed");
    await track(Promise.resolve(malformedFixture));
    mocks.clerk.session(malformedFixture.userId, malformedFixture.orgId);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );

    // When + Then: 400 — malformed JSON returns
    // CODEX_AUTH_JSON_SHAPE_INVALID.
    const malformedResponse = await accept(
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
    expect(malformedResponse.body).toMatchObject({
      error: { code: "CODEX_AUTH_JSON_SHAPE_INVALID" },
    });

    // Given: a fresh fixture + a JSON blob missing
    // `tokens.refresh_token`.
    const missingRtFixture = uniqueOrgUser("zmmp-codex-missing-rt");
    await track(Promise.resolve(missingRtFixture));
    mocks.clerk.session(missingRtFixture.userId, missingRtFixture.orgId);
    const incomplete = JSON.stringify({
      tokens: {
        access_token: makeJwt({ exp: now() }),
        // refresh_token omitted
        account_id: "ws_acct",
        id_token: makeIdToken({ accountId: "ws_acct", planType: "plus" }),
      },
    });

    // When + Then: 400 — missing refresh_token returns
    // CODEX_AUTH_JSON_SHAPE_INVALID.
    const missingRtResponse = await accept(
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
    expect(missingRtResponse.body).toMatchObject({
      error: { code: "CODEX_AUTH_JSON_SHAPE_INVALID" },
    });

    // Given: a fresh fixture + a free-plan auth.json.
    const freeFixture = uniqueOrgUser("zmmp-codex-free");
    await track(Promise.resolve(freeFixture));
    mocks.clerk.session(freeFixture.userId, freeFixture.orgId);

    // When + Then: 400 — free-plan accounts are rejected
    // with CODEX_FREE_PLAN_REJECTED.
    const freeResponse = await accept(
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
    expect(freeResponse.body).toMatchObject({
      error: { code: "CODEX_FREE_PLAN_REJECTED" },
    });

    // Given: a fresh fixture + a body without
    // CODEX_AUTH_JSON.
    const noBlobFixture = uniqueOrgUser("zmmp-codex-no-blob");
    await track(Promise.resolve(noBlobFixture));
    mocks.clerk.session(noBlobFixture.userId, noBlobFixture.orgId);

    // When + Then: 400 — missing CODEX_AUTH_JSON blob
    // returns BAD_REQUEST.
    const noBlobResponse = await accept(
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
    expect(noBlobResponse.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});
