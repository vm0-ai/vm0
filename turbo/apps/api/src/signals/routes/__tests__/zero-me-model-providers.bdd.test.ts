import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

type DeletableProviderType = "claude-code-oauth-token" | "codex-oauth-token";

interface ProviderCleanup {
  readonly owner: Actor;
  readonly type: DeletableProviderType;
}

function actor(): Actor {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function mainClient() {
  return setupApp({ context })(zeroPersonalModelProvidersMainContract);
}

function byTypeClient() {
  return setupApp({ context })(zeroPersonalModelProvidersByTypeContract);
}

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
  readonly accountId: string;
  readonly planType: string;
  readonly workspaceName?: string;
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

function makeAuthJson(overrides?: { readonly planType?: string }): string {
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

function incompleteAuthJson(): string {
  return JSON.stringify({
    tokens: {
      access_token: makeJwt({ exp: now() }),
      account_id: "ws_acct",
      id_token: makeIdToken({ accountId: "ws_acct", planType: "plus" }),
    },
  });
}

async function deleteProvider(
  owner: Actor,
  type: DeletableProviderType,
): Promise<void> {
  mocks.clerk.session(owner.userId, owner.orgId);
  await accept(
    byTypeClient().delete({
      params: { type },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

const trackProviderCleanup = createFixtureTracker<ProviderCleanup>(
  async (provider) => {
    await deleteProvider(provider.owner, provider.type);
  },
);

async function trackProvider(
  owner: Actor,
  type: DeletableProviderType,
): Promise<void> {
  await trackProviderCleanup(Promise.resolve({ owner, type }));
}

describe("/api/zero/me/model-providers BDD", () => {
  it("requires authentication and an active organization for list, upsert, and delete", async () => {
    const main = mainClient();
    const byType = byTypeClient();

    const listUnauthenticated = await accept(main.list({ headers: {} }), [401]);
    const upsertUnauthenticated = await accept(
      main.upsert({
        body: { type: "claude-code-oauth-token", secret: "sk-test" },
        headers: {},
      }),
      [401],
    );
    const deleteUnauthenticated = await accept(
      byType.delete({
        params: { type: "claude-code-oauth-token" },
        headers: {},
      }),
      [401],
    );

    expect(listUnauthenticated.body.error.code).toBe("UNAUTHORIZED");
    expect(upsertUnauthenticated.body.error.code).toBe("UNAUTHORIZED");
    expect(deleteUnauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const listNoOrg = await accept(
      main.list({ headers: authHeaders() }),
      [401],
    );
    const upsertNoOrg = await accept(
      main.upsert({
        body: { type: "claude-code-oauth-token", secret: "sk-test" },
        headers: authHeaders(),
      }),
      [401],
    );
    const deleteNoOrg = await accept(
      byType.delete({
        params: { type: "claude-code-oauth-token" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(listNoOrg.body.error.code).toBe("UNAUTHORIZED");
    expect(upsertNoOrg.body.error.code).toBe("UNAUTHORIZED");
    expect(deleteNoOrg.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates, updates, lists, isolates, and deletes the current user's provider", async () => {
    const alice = actor();
    const bob = { orgId: alice.orgId, userId: `user_${randomUUID()}` };
    const main = mainClient();
    await trackProvider(alice, "claude-code-oauth-token");
    await trackProvider(bob, "claude-code-oauth-token");

    mocks.clerk.session(alice.userId, alice.orgId);
    const empty = await accept(main.list({ headers: authHeaders() }), [200]);

    expect(empty.body.modelProviders).toStrictEqual([]);

    const created = await accept(
      main.upsert({
        body: { type: "claude-code-oauth-token", secret: "first" },
        headers: authHeaders(),
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

    const updated = await accept(
      main.upsert({
        body: { type: "claude-code-oauth-token", secret: "second" },
        headers: authHeaders(),
      }),
      [200],
    );
    const aliceList = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );

    expect(updated.body.created).toBeFalsy();
    expect(updated.body.provider.id).toBe(created.body.provider.id);
    expect(aliceList.body.modelProviders).toHaveLength(1);
    expect(aliceList.body.modelProviders[0]?.id).toBe(created.body.provider.id);

    mocks.clerk.session(bob.userId, bob.orgId);
    const bobList = await accept(main.list({ headers: authHeaders() }), [200]);
    const bobDelete = await accept(
      byTypeClient().delete({
        params: { type: "claude-code-oauth-token" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(bobList.body.modelProviders).toStrictEqual([]);
    expect(bobDelete.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    mocks.clerk.session(alice.userId, alice.orgId);
    const stillThere = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );

    expect(stillThere.body.modelProviders[0]?.id).toBe(
      created.body.provider.id,
    );

    const deleted = await byTypeClient().delete({
      params: { type: "claude-code-oauth-token" },
      headers: authHeaders(),
    });
    expect(deleted.status).toBe(204);

    const afterDelete = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );
    const deleteAgain = await accept(
      byTypeClient().delete({
        params: { type: "claude-code-oauth-token" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(afterDelete.body.modelProviders).toStrictEqual([]);
    expect(deleteAgain.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });

  it("rejects unsupported providers and invalid provider shapes", async () => {
    const owner = actor();
    mocks.clerk.session(owner.userId, owner.orgId);
    const client = mainClient();

    const missingSecret = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token" },
        headers: authHeaders(),
      }),
      [400],
    );
    const anthropic = await accept(
      client.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: authHeaders(),
      }),
      [404],
    );
    const vm0WithSecret = await accept(
      client.upsert({
        body: { type: "vm0", secret: "any-value" },
        headers: authHeaders(),
      }),
      [404],
    );
    const vm0NoSecret = await accept(
      client.upsert({
        body: { type: "vm0" },
        headers: authHeaders(),
      }),
      [404],
    );
    const openai = await accept(
      client.upsert({
        body: {
          type: "openai-api-key",
          secret: "sk-proj-test",
          selectedModel: "gpt-5.5",
        },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(missingSecret.body.error.code).toBe("BAD_REQUEST");
    expect(anthropic.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "anthropic-api-key" not found',
      },
    });
    expect(vm0WithSecret.body.error.code).toBe("NOT_FOUND");
    expect(vm0NoSecret.body.error.code).toBe("NOT_FOUND");
    expect(openai.body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'Provider "openai-api-key" not found',
      },
    });
  });

  it("handles codex auth_json validation and lists the accepted provider metadata", async () => {
    const owner = actor();
    mocks.clerk.session(owner.userId, owner.orgId);
    const client = mainClient();
    await trackProvider(owner, "codex-oauth-token");

    const malformed = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: "{ not json" },
        },
        headers: authHeaders(),
      }),
      [400],
    );
    const missingRefreshToken = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: incompleteAuthJson() },
        },
        headers: authHeaders(),
      }),
      [400],
    );
    const freePlan = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson({ planType: "free" }) },
        },
        headers: authHeaders(),
      }),
      [400],
    );
    const missingBlob = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {},
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(malformed.body.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
    expect(missingRefreshToken.body.error.code).toBe(
      "CODEX_AUTH_JSON_SHAPE_INVALID",
    );
    expect(freePlan.body.error.code).toBe("CODEX_FREE_PLAN_REJECTED");
    expect(missingBlob.body.error.code).toBe("BAD_REQUEST");

    const accepted = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
        headers: authHeaders(),
      }),
      [201],
    );
    const listed = await accept(client.list({ headers: authHeaders() }), [200]);

    expect(accepted.body).toMatchObject({
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Personal Acme",
        planType: "plus",
        needsReconnect: false,
      },
    });
    expect(listed.body.modelProviders).toHaveLength(1);
    expect(listed.body.modelProviders[0]).toMatchObject({
      id: accepted.body.provider.id,
      type: "codex-oauth-token",
      authMethod: "auth_json",
      workspaceName: "Personal Acme",
      planType: "plus",
    });
  });
});
