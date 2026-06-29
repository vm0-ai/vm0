import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { createStore } from "ccstate";
import {
  zeroModelProvidersByTypeContract,
  zeroModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-model-providers";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { modelProviders } from "@vm0/db/schema/model-provider";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgModelProviders$,
  seedOrgModelProvider$,
  type OrgModelProviderFixture,
} from "./helpers/zero-model-providers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ORG_SENTINEL_USER_ID = "__org__";

function uniqueOrgUser(prefix: string): {
  readonly orgId: string;
  readonly userId: string;
} {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
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

function makeAuthJson(overrides?: {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly planType?: string;
}): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: overrides?.accessToken ?? makeJwt({ exp: accessExp }),
      refresh_token: overrides?.refreshToken ?? "rt_org_synthetic_high_entropy",
      account_id: "ws_acct_plain",
      id_token: makeIdToken({
        accountId: "ws_acct_from_id_token_org",
        planType: overrides?.planType ?? "plus",
        workspaceName: "Org Acme",
      }),
    },
  });
}

async function setOrgModelProviderStale(
  orgId: string,
  type: string,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .update(modelProviders)
    .set({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, type),
      ),
    );
}

describe("GET /api/zero/model-providers", () => {
  const track = createFixtureTracker<OrgModelProviderFixture>((fixture) => {
    return store.set(deleteOrgModelProviders$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns empty list when no org providers exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    await track(Promise.resolve({ orgId }));

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders).toStrictEqual([]);
  });

  it("allows organization members to list org providers", async () => {
    const fixture = uniqueOrgUser("zmp-list-member");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    await track(Promise.resolve({ orgId: fixture.orgId }));

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders).toStrictEqual([]);
  });

  it("lists org providers", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId }));

    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders).toHaveLength(1);
    expect(response.body.modelProviders[0]?.type).toBe("anthropic-api-key");
  });

  it("does not show first provider as default", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId }));

    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders[0]?.isDefault).toBeFalsy();
  });

  it("does not show same-framework providers as default", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId }));

    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );
    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "claude-code-oauth-token", secret: "sk-claude-test" },
      }),
      [201],
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const anthropic = response.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.type === "anthropic-api-key";
      },
    );
    const oauth = response.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.type === "claude-code-oauth-token";
      },
    );
    expect(anthropic?.isDefault).toBeFalsy();
    expect(oauth?.isDefault).toBeFalsy();
  });

  it("does not mark provider rows as framework defaults via list", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(Promise.resolve({ orgId }));

    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const defaultProvider = response.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.isDefault && provider.framework === "claude-code";
      },
    );
    expect(defaultProvider).toBeUndefined();
  });

  it("has no default for framework when no providers exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    await track(Promise.resolve({ orgId }));

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const defaultProvider = response.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.isDefault && provider.framework === "claude-code";
      },
    );
    expect(defaultProvider).toBeUndefined();
  });

  it("surfaces OAuth refresh state on listed providers", async () => {
    const fixture = uniqueOrgUser("zmp-list-stale");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroModelProvidersMainContract);

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
      }),
      [201],
    );
    await setOrgModelProviderStale(fixture.orgId, "codex-oauth-token");

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const provider = response.body.modelProviders.find(
      (candidate: ModelProviderResponse) => {
        return candidate.type === "codex-oauth-token";
      },
    );
    expect(provider?.needsReconnect).toBeTruthy();
    expect(provider?.lastRefreshErrorCode).toBe("refresh_token_expired");
  });
});

describe("POST /api/zero/model-providers", () => {
  const track = createFixtureTracker<OrgModelProviderFixture>((fixture) => {
    return store.set(deleteOrgModelProviders$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.upsert({
        headers: {},
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the caller is not an org admin", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-member");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Only admins can manage org model providers",
    );
  });

  it("creates and updates an org single-secret provider", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-single");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const first = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "anthropic-api-key",
          secret: "sk-ant-v1",
        },
      }),
      [201],
    );
    const second = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "anthropic-api-key",
          secret: "sk-ant-v2",
        },
      }),
      [200],
    );

    expect(first.body.created).toBeTruthy();
    expect(second.body.created).toBeFalsy();
    expect(second.body.provider.id).toBe(first.body.provider.id);
    expect(second.body.provider.selectedModel).toBeNull();
    expect(second.body.provider.isDefault).toBeFalsy();

    const list = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const provider = list.body.modelProviders.find(
      (candidate: ModelProviderResponse) => {
        return candidate.type === "anthropic-api-key";
      },
    );
    expect(provider?.id).toBe(first.body.provider.id);
    expect(provider?.secretName).toBe("ANTHROPIC_API_KEY");
  });

  it("rejects whitespace-only org single-secret provider secrets", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-blank-secret");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "openrouter-api-key",
          secret: "   ",
        },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      'Provider "openrouter-api-key" requires a non-empty secret',
    );
    const list = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "openrouter-api-key";
      }),
    ).toBeUndefined();
  });

  it("creates org-level AWS Bedrock multi-auth provider", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-bedrock");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "aws-bedrock",
          authMethod: "access-keys",
          secrets: {
            AWS_ACCESS_KEY_ID: "test-access-key",
            AWS_SECRET_ACCESS_KEY: "test-secret-key",
            AWS_REGION: "us-east-1",
          },
        },
      }),
      [201],
    );

    expect(response.body.provider.type).toBe("aws-bedrock");
    expect(response.body.provider.authMethod).toBe("access-keys");
    expect(response.body.provider.secretNames).toStrictEqual(
      expect.arrayContaining([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
      ]),
    );
    const list = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const provider = list.body.modelProviders.find(
      (candidate: ModelProviderResponse) => {
        return candidate.type === "aws-bedrock";
      },
    );
    expect(provider?.authMethod).toBe("access-keys");
    expect(provider?.secretNames).toStrictEqual(
      expect.arrayContaining([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
      ]),
    );
  });

  it("rejects invalid multi-auth shape for single-secret providers", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-bad-multi");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "anthropic-api-key",
          authMethod: "api-key",
          secrets: { ANTHROPIC_API_KEY: "sk-ant-test" },
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("creates an openai-api-key provider by default", async () => {
    const fixture = uniqueOrgUser("zmp-openai");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "openai-api-key",
          secret: "sk-proj-test",
        },
      }),
      [201],
    );
    expect(response.body.provider.framework).toBe("codex");
    expect(response.body.provider.type).toBe("openai-api-key");

    const other = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );
    expect(other.body.provider.type).toBe("anthropic-api-key");
  });

  it("does not mark provider rows as defaults across frameworks", async () => {
    const fixture = uniqueOrgUser("zmp-cross-framework");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );
    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "openai-api-key",
          secret: "sk-proj-test",
        },
      }),
      [201],
    );

    const list = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      list.body.modelProviders.filter((provider: ModelProviderResponse) => {
        return provider.isDefault;
      }),
    ).toHaveLength(0);
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "anthropic-api-key";
      })?.isDefault,
    ).toBeFalsy();
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "openai-api-key";
      })?.isDefault,
    ).toBeFalsy();
  });

  it("creates a vm0 no-secret org provider", async () => {
    const fixture = uniqueOrgUser("zmp-vm0");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "vm0" },
      }),
      [201],
    );

    expect(response.body.provider.type).toBe("vm0");
    expect(response.body.provider.secretName).toBeNull();
    expect(response.body.provider.authMethod).toBeNull();
    expect(response.body.provider.selectedModel).toBeNull();
  });

  it("handles codex auth_json paste", async () => {
    const fixture = uniqueOrgUser("zmp-codex-paste");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
      }),
      [201],
    );

    expect(response.body.provider.type).toBe("codex-oauth-token");
    expect(response.body.provider.authMethod).toBe("auth_json");
    expect(response.body.provider.workspaceName).toBe("Org Acme");
    expect(response.body.provider.planType).toBe("plus");
    expect(response.body.provider).toMatchObject({
      workspaceName: "Org Acme",
      planType: "plus",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("returns typed codex auth_json validation errors", async () => {
    const fixture = uniqueOrgUser("zmp-codex-invalid");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    const malformed = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: "{ not json" },
        },
      }),
      [400],
    );
    expect(malformed.body.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");

    const free = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson({ planType: "free" }) },
        },
      }),
      [400],
    );
    expect(free.body.error.code).toBe("CODEX_FREE_PLAN_REJECTED");

    const missing = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {},
        },
      }),
      [400],
    );
    expect(missing.body.error.code).toBe("BAD_REQUEST");

    const missingRefresh = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: JSON.stringify({
              tokens: {
                access_token: makeJwt({ exp: Math.floor(now() / 1000) + 7200 }),
                account_id: "ws_acct",
                id_token: makeIdToken({
                  accountId: "ws_acct",
                  planType: "plus",
                }),
              },
            }),
          },
        },
      }),
      [400],
    );
    expect(missingRefresh.body.error.code).toBe(
      "CODEX_AUTH_JSON_SHAPE_INVALID",
    );
  });

  it("re-paste clears codex reconnect state", async () => {
    const fixture = uniqueOrgUser("zmp-codex-repaste");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersMainContract);

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
      }),
      [201],
    );
    await setOrgModelProviderStale(fixture.orgId, "codex-oauth-token");
    const stale = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const staleProvider = stale.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.type === "codex-oauth-token";
      },
    );
    expect(staleProvider?.needsReconnect).toBeTruthy();

    const freshAccess = makeJwt({
      exp: Math.floor(now() / 1000) + 7200,
      sub: "fresh",
    });
    const repaste = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: makeAuthJson({
              accessToken: freshAccess,
              refreshToken: "rt_fresh_org",
            }),
          },
        },
      }),
      [200],
    );
    expect(repaste.body.created).toBeFalsy();
    expect(repaste.body.provider.needsReconnect).toBeFalsy();
    expect(repaste.body.provider.lastRefreshErrorCode).toBeNull();
  });
});

describe("DELETE /api/zero/model-providers/:type", () => {
  const track = createFixtureTracker<OrgModelProviderFixture>((fixture) => {
    return store.set(deleteOrgModelProviders$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroModelProvidersByTypeContract);

    const response = await accept(
      client.delete({ headers: {}, params: { type: "anthropic-api-key" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    const client = setupApp({ context })(zeroModelProvidersByTypeContract);

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for non-admin members", async () => {
    const fixture = uniqueOrgUser("zmp-delete-member");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({ context })(zeroModelProvidersByTypeContract);

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Only admins can manage org model providers",
    );
  });

  it("returns 404 when the target provider is absent", async () => {
    const fixture = uniqueOrgUser("zmp-delete-missing");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context })(zeroModelProvidersByTypeContract);

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Resource not found");
  });

  it("deletes an org single-secret provider", async () => {
    const fixture = uniqueOrgUser("zmp-delete-legacy");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const mainClient = setupApp({ context })(zeroModelProvidersMainContract);
    const byTypeClient = setupApp({ context })(
      zeroModelProvidersByTypeContract,
    );

    await accept(
      mainClient.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );

    const response = await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const list = await accept(
      mainClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "anthropic-api-key";
      }),
    ).toBeUndefined();

    const deletedAgain = await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [404],
    );
    expect(deletedAgain.body.error.message).toBe("Resource not found");
  });

  it("deletes a codex auth_json provider", async () => {
    const fixture = uniqueOrgUser("zmp-delete-multiauth");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const mainClient = setupApp({ context })(zeroModelProvidersMainContract);
    const byTypeClient = setupApp({ context })(
      zeroModelProvidersByTypeContract,
    );

    await accept(
      mainClient.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
      }),
      [201],
    );

    await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "codex-oauth-token" },
      }),
      [204],
    );

    const list = await accept(
      mainClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "codex-oauth-token";
      }),
    ).toBeUndefined();

    const deletedAgain = await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "codex-oauth-token" },
      }),
      [404],
    );
    expect(deletedAgain.body.error.message).toBe("Resource not found");
  });

  it("does not promote another provider when deleting an old default row", async () => {
    const fixture = uniqueOrgUser("zmp-delete-default");
    await track(Promise.resolve({ orgId: fixture.orgId }));
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fixture.orgId,
        type: "anthropic-api-key",
        secretName: "ANTHROPIC_API_KEY",
        isDefault: true,
      },
      context.signal,
    );
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fixture.orgId,
        type: "openai-api-key",
        secretName: "OPENAI_API_KEY",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const mainClient = setupApp({ context })(zeroModelProvidersMainContract);
    const byTypeClient = setupApp({ context })(
      zeroModelProvidersByTypeContract,
    );

    await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );

    const list = await accept(
      mainClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const remaining = list.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.type === "openai-api-key";
      },
    );
    expect(remaining?.isDefault).toBeFalsy();
  });
});
