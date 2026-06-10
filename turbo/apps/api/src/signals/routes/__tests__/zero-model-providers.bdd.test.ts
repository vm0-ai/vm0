import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroModelProvidersByTypeContract,
  zeroModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-model-providers";

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

interface ProviderCleanup {
  readonly owner: Actor;
  readonly type: ModelProviderType;
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
  return setupApp({ context })(zeroModelProvidersMainContract);
}

function byTypeClient() {
  return setupApp({ context })(zeroModelProvidersByTypeContract);
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
  readonly planType?: string;
  readonly refreshToken?: string;
}): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: makeJwt({ exp: accessExp }),
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

function incompleteAuthJson(): string {
  return JSON.stringify({
    tokens: {
      access_token: makeJwt({ exp: Math.floor(now() / 1000) + 7200 }),
      account_id: "ws_acct",
      id_token: makeIdToken({ accountId: "ws_acct", planType: "plus" }),
    },
  });
}

function findProvider(
  providers: readonly ModelProviderResponse[],
  type: ModelProviderType,
): ModelProviderResponse | undefined {
  return providers.find((provider) => {
    return provider.type === type;
  });
}

async function deleteProvider(
  owner: Actor,
  type: ModelProviderType,
): Promise<void> {
  mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
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
  type: ModelProviderType,
): Promise<void> {
  await trackProviderCleanup(Promise.resolve({ owner, type }));
}

describe("/api/zero/model-providers BDD", () => {
  it("requires authentication and an active organization for list, upsert, and delete", async () => {
    const main = mainClient();
    const byType = byTypeClient();

    const listUnauthenticated = await accept(main.list({ headers: {} }), [401]);
    const upsertUnauthenticated = await accept(
      main.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: {},
      }),
      [401],
    );
    const deleteUnauthenticated = await accept(
      byType.delete({
        params: { type: "anthropic-api-key" },
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
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: authHeaders(),
      }),
      [401],
    );
    const deleteNoOrg = await accept(
      byType.delete({
        params: { type: "anthropic-api-key" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(listNoOrg.body.error.code).toBe("UNAUTHORIZED");
    expect(upsertNoOrg.body.error.code).toBe("UNAUTHORIZED");
    expect(deleteNoOrg.body.error.code).toBe("UNAUTHORIZED");
  });

  it("allows members to list providers but only admins can mutate them", async () => {
    const owner = actor();
    const member = { orgId: owner.orgId, userId: `user_${randomUUID()}` };
    const main = mainClient();
    const byType = byTypeClient();

    mocks.clerk.session(member.userId, member.orgId, "org:member");
    const list = await accept(main.list({ headers: authHeaders() }), [200]);
    const upsert = await accept(
      main.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
        headers: authHeaders(),
      }),
      [403],
    );
    const deleted = await accept(
      byType.delete({
        params: { type: "anthropic-api-key" },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(list.body.modelProviders).toStrictEqual([]);
    expect(upsert.body.error.message).toBe(
      "Only admins can manage org model providers",
    );
    expect(deleted.body.error.message).toBe(
      "Only admins can manage org model providers",
    );
  });

  it("creates, updates, lists, isolates, and deletes org single-secret providers", async () => {
    const owner = actor();
    const member = { orgId: owner.orgId, userId: `user_${randomUUID()}` };
    const stranger = actor();
    const main = mainClient();
    const byType = byTypeClient();
    await trackProvider(owner, "anthropic-api-key");
    await trackProvider(owner, "claude-code-oauth-token");
    await trackProvider(owner, "openai-api-key");

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const empty = await accept(main.list({ headers: authHeaders() }), [200]);

    expect(empty.body.modelProviders).toStrictEqual([]);

    const anthropic = await accept(
      main.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-v1" },
        headers: authHeaders(),
      }),
      [201],
    );
    const updatedAnthropic = await accept(
      main.upsert({
        body: { type: "anthropic-api-key", secret: "sk-ant-v2" },
        headers: authHeaders(),
      }),
      [200],
    );
    const claudeOAuth = await accept(
      main.upsert({
        body: { type: "claude-code-oauth-token", secret: "oauth-token" },
        headers: authHeaders(),
      }),
      [201],
    );
    const openai = await accept(
      main.upsert({
        body: { type: "openai-api-key", secret: "sk-proj-test" },
        headers: authHeaders(),
      }),
      [201],
    );
    const ownerList = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );

    expect(anthropic.body).toMatchObject({
      provider: {
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        secretNames: null,
        authMethod: null,
        selectedModel: null,
        isDefault: false,
      },
      created: true,
    });
    expect(updatedAnthropic.body.created).toBeFalsy();
    expect(updatedAnthropic.body.provider.id).toBe(anthropic.body.provider.id);
    expect(claudeOAuth.body.provider).toMatchObject({
      type: "claude-code-oauth-token",
      framework: "claude-code",
      isDefault: false,
    });
    expect(openai.body.provider).toMatchObject({
      type: "openai-api-key",
      framework: "codex",
      isDefault: false,
    });
    expect(ownerList.body.modelProviders).toHaveLength(3);
    expect(
      ownerList.body.modelProviders.filter((provider) => {
        return provider.isDefault;
      }),
    ).toStrictEqual([]);
    expect(
      findProvider(ownerList.body.modelProviders, "anthropic-api-key")?.id,
    ).toBe(anthropic.body.provider.id);
    expect(
      findProvider(ownerList.body.modelProviders, "claude-code-oauth-token")
        ?.id,
    ).toBe(claudeOAuth.body.provider.id);
    expect(
      findProvider(ownerList.body.modelProviders, "openai-api-key")?.id,
    ).toBe(openai.body.provider.id);

    mocks.clerk.session(member.userId, member.orgId, "org:member");
    const memberList = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );

    expect(memberList.body.modelProviders).toHaveLength(3);

    mocks.clerk.session(stranger.userId, stranger.orgId, "org:admin");
    const strangerList = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );
    const strangerDelete = await accept(
      byType.delete({
        params: { type: "anthropic-api-key" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(strangerList.body.modelProviders).toStrictEqual([]);
    expect(strangerDelete.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    await accept(
      byType.delete({
        params: { type: "anthropic-api-key" },
        headers: authHeaders(),
      }),
      [204],
    );
    const afterDelete = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );

    expect(
      findProvider(afterDelete.body.modelProviders, "anthropic-api-key"),
    ).toBeUndefined();
    expect(
      findProvider(afterDelete.body.modelProviders, "openai-api-key"),
    ).toMatchObject({ isDefault: false });
  });

  it("creates, lists, and deletes org multi-auth providers", async () => {
    const owner = actor();
    const main = mainClient();
    const byType = byTypeClient();
    await trackProvider(owner, "aws-bedrock");

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const created = await accept(
      main.upsert({
        body: {
          type: "aws-bedrock",
          authMethod: "access-keys",
          secrets: {
            AWS_ACCESS_KEY_ID: "test-access-key",
            AWS_SECRET_ACCESS_KEY: "test-secret-key",
            AWS_REGION: "us-east-1",
          },
        },
        headers: authHeaders(),
      }),
      [201],
    );
    const listed = await accept(main.list({ headers: authHeaders() }), [200]);

    expect(created.body.provider).toMatchObject({
      type: "aws-bedrock",
      authMethod: "access-keys",
      secretNames: expect.arrayContaining([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
      ]),
    });
    expect(
      findProvider(listed.body.modelProviders, "aws-bedrock"),
    ).toMatchObject({
      id: created.body.provider.id,
      authMethod: "access-keys",
    });

    await accept(
      byType.delete({
        params: { type: "aws-bedrock" },
        headers: authHeaders(),
      }),
      [204],
    );
    const afterDelete = await accept(
      main.list({ headers: authHeaders() }),
      [200],
    );

    expect(
      findProvider(afterDelete.body.modelProviders, "aws-bedrock"),
    ).toBeUndefined();
  });

  it("creates and lists the vm0 no-secret org provider", async () => {
    const owner = actor();
    const main = mainClient();
    await trackProvider(owner, "vm0");

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const created = await accept(
      main.upsert({
        body: { type: "vm0" },
        headers: authHeaders(),
      }),
      [201],
    );
    const listed = await accept(main.list({ headers: authHeaders() }), [200]);

    expect(created.body.provider).toMatchObject({
      type: "vm0",
      secretName: null,
      authMethod: null,
      selectedModel: null,
    });
    expect(findProvider(listed.body.modelProviders, "vm0")).toMatchObject({
      id: created.body.provider.id,
      secretName: null,
      authMethod: null,
    });
  });

  it("rejects invalid provider shapes and accepts Codex auth_json metadata", async () => {
    const owner = actor();
    const main = mainClient();
    await trackProvider(owner, "codex-oauth-token");

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const badSingleSecretShape = await accept(
      main.upsert({
        body: {
          type: "anthropic-api-key",
          authMethod: "api-key",
          secrets: { ANTHROPIC_API_KEY: "sk-ant-test" },
        },
        headers: authHeaders(),
      }),
      [400],
    );
    const malformed = await accept(
      main.upsert({
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
      main.upsert({
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
      main.upsert({
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
      main.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {},
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(badSingleSecretShape.body.error.code).toBe("BAD_REQUEST");
    expect(malformed.body.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
    expect(missingRefreshToken.body.error.code).toBe(
      "CODEX_AUTH_JSON_SHAPE_INVALID",
    );
    expect(freePlan.body.error.code).toBe("CODEX_FREE_PLAN_REJECTED");
    expect(missingBlob.body.error.code).toBe("BAD_REQUEST");

    const accepted = await accept(
      main.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
        headers: authHeaders(),
      }),
      [201],
    );
    const repaste = await accept(
      main.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: makeAuthJson({
              refreshToken: "rt_org_synthetic_repaste",
            }),
          },
        },
        headers: authHeaders(),
      }),
      [200],
    );
    const listed = await accept(main.list({ headers: authHeaders() }), [200]);

    expect(accepted.body).toMatchObject({
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Org Acme",
        planType: "plus",
        needsReconnect: false,
        lastRefreshErrorCode: null,
      },
      created: true,
    });
    expect(repaste.body.created).toBeFalsy();
    expect(repaste.body.provider.id).toBe(accepted.body.provider.id);
    expect(repaste.body.provider.needsReconnect).toBeFalsy();
    expect(repaste.body.provider.lastRefreshErrorCode).toBeNull();
    expect(
      findProvider(listed.body.modelProviders, "codex-oauth-token"),
    ).toMatchObject({
      id: accepted.body.provider.id,
      authMethod: "auth_json",
      workspaceName: "Org Acme",
      planType: "plus",
    });
  });
});
