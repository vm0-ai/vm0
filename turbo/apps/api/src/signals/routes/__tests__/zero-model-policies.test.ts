import { randomUUID } from "node:crypto";

import { createStore, command } from "ccstate";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  DEFAULT_ORG_MODEL_POLICY_MODELS,
  type ModelProviderType,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

interface ModelPolicyFixture {
  readonly orgId: string;
  readonly userId: string;
}

const ORG_SENTINEL_USER_ID = "__org__";
const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const MODEL_POLICIES_PATH = "/api/zero/model-policies";

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

const seedModelPolicyFixture$ = command(
  async (
    { set },
    switches: Record<string, boolean>,
    signal: AbortSignal,
  ): Promise<ModelPolicyFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    await writeDb.insert(userFeatureSwitches).values({
      orgId,
      userId,
      switches,
    });
    signal.throwIfAborted();
    await writeDb.insert(orgMembersCache).values({
      orgId,
      userId,
      role: "admin",
    });
    signal.throwIfAborted();

    return { orgId, userId };
  },
);

const deleteModelPolicyFixture$ = command(
  async (
    { set },
    fixture: ModelPolicyFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);

    await writeDb
      .delete(orgModelPolicies)
      .where(eq(orgModelPolicies.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(modelProviders)
      .where(eq(modelProviders.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
  },
);

const insertOrgProvider$ = command(
  async (
    { set },
    params: { readonly orgId: string; readonly type: ModelProviderType },
    signal: AbortSignal,
  ): Promise<string> => {
    const writeDb = set(writeDb$);
    const [provider] = await writeDb
      .insert(modelProviders)
      .values({
        orgId: params.orgId,
        userId: ORG_SENTINEL_USER_ID,
        type: params.type,
      })
      .returning({ id: modelProviders.id });
    signal.throwIfAborted();

    if (!provider) {
      throw new Error("Expected inserted model provider");
    }
    return provider.id;
  },
);

function toUpdate(data: OrgModelPoliciesResponse): UpdateOrgModelPolicy[] {
  return data.policies.map((policy) => {
    return {
      model: policy.model,
      isDefault: policy.isDefault,
      defaultProviderType: policy.defaultProviderType,
      credentialScope: policy.credentialScope,
      modelProviderId: policy.modelProviderId,
    };
  });
}

function makeVm0Policy(
  model: UpdateOrgModelPolicy["model"],
  isDefault = false,
): UpdateOrgModelPolicy {
  return {
    model,
    isDefault,
    defaultProviderType: "vm0",
    credentialScope: "org",
    modelProviderId: null,
  };
}

function apiClient() {
  return setupApp({ context })(zeroModelPoliciesMainContract);
}

async function putRawModelPolicies(body: string): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(MODEL_POLICIES_PATH, {
    method: "PUT",
    headers: {
      authorization: "Bearer clerk-session",
      "content-type": "application/json",
    },
    body,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function seedFixture(
  switches: Record<string, boolean>,
): Promise<ModelPolicyFixture> {
  return track(store.set(seedModelPolicyFixture$, switches, context.signal));
}

const track = createFixtureTracker<ModelPolicyFixture>((fixture) => {
  return store.set(deleteModelPolicyFixture$, fixture, context.signal);
});

describe("GET/PUT /api/zero/model-policies", () => {
  it("returns 401 for unauthenticated reads and writes", async () => {
    const client = apiClient();

    const listResponse = await client.list({ headers: {} });
    const updateResponse = await client.update({
      headers: {},
      body: { policies: [] },
    });

    expect(listResponse.status).toBe(401);
    expect(listResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(updateResponse.status).toBe(401);
    expect(updateResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 for sessions without an active organization", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, null);
    const client = apiClient();

    const listResponse = await client.list({
      headers: { authorization: "Bearer clerk-session" },
    });
    const updateResponse = await client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: [] },
    });

    expect(listResponse.status).toBe(401);
    expect(listResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(updateResponse.status).toBe(401);
    expect(updateResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("lists model policy controls without a feature switch", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
  });

  it("lists seeded curated models and the explicit default when enabled", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(DEFAULT_ORG_MODEL_POLICY_MODELS);
    expect(response.body.policies[0]).toMatchObject({
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
    });
    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
    expect(
      response.body.policies.find((policy) => {
        return policy.isDefault;
      })?.model,
    ).toBe(DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL);
  });

  it("allows members to read policy controls", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      apiClient().list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(DEFAULT_ORG_MODEL_POLICY_MODELS);
    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
  });

  it("allows zero tokens to read policy controls without a model-provider capability", async () => {
    const fixture = await seedFixture({});
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      apiClient().list({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
  });

  it("requires admins for policy writes", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await apiClient().update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: [] },
    });

    expect(response.status).toBe(403);
    expect(response.body).toStrictEqual({
      error: {
        message: "Only admins can manage model policies",
        code: "FORBIDDEN",
      },
    });
  });

  it("updates the explicit workspace default", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = toUpdate(listResponse.body);

    updates[1] = { ...updates[1]!, isDefault: true };
    for (let index = 0; index < updates.length; index += 1) {
      if (index !== 1) {
        updates[index] = { ...updates[index]!, isDefault: false };
      }
    }

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { policies: updates },
      }),
      [200],
    );

    const firstPolicy = response.body.policies.find((policy) => {
      return policy.model === DEFAULT_ORG_MODEL_POLICY_MODELS[0];
    });
    const secondPolicy = response.body.policies.find((policy) => {
      return policy.model === DEFAULT_ORG_MODEL_POLICY_MODELS[1];
    });
    expect(firstPolicy?.isDefault).toBeFalsy();
    expect(secondPolicy?.isDefault).toBeTruthy();
    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_MODELS[1],
    );
  });

  it("removes supported models omitted from an update", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const removedModel = "claude-sonnet-4-6";
    const updates = toUpdate(listResponse.body).filter((policy) => {
      return policy.model !== removedModel;
    });

    const updateResponse = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { policies: updates },
      }),
      [200],
    );
    const secondListResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(
      updateResponse.body.policies.some((policy) => {
        return policy.model === removedModel;
      }),
    ).toBeFalsy();
    expect(
      secondListResponse.body.policies.some((policy) => {
        return policy.model === removedModel;
      }),
    ).toBeFalsy();
  });

  it("allows adding a supported model that was not seeded by default", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeVm0Policy("claude-opus-4-6"),
    ];

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { policies: updates },
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "deepseek-v4-pro",
      "gpt-5.5",
    ]);
  });

  it("allows compatible org provider routes", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const providerId = await store.set(
      insertOrgProvider$,
      { orgId: fixture.orgId, type: "openrouter-api-key" },
      context.signal,
    );
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      {
        model: "glm-5.1",
        isDefault: false,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      } satisfies UpdateOrgModelPolicy,
    ];

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { policies: updates },
      }),
      [200],
    );
    const glm = response.body.policies.find((policy) => {
      return policy.model === "glm-5.1";
    });

    expect(glm).toMatchObject({
      defaultProviderType: "openrouter-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
      routeStatus: "valid",
    });
  });

  it("allows compatible member OAuth provider routes", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "claude-opus-4-7") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "claude-code-oauth-token" as const,
        credentialScope: "member" as const,
        modelProviderId: null,
      };
    });

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { policies: updates },
      }),
      [200],
    );
    const opus = response.body.policies.find((policy) => {
      return policy.model === "claude-opus-4-7";
    });

    expect(opus).toMatchObject({
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      routeStatus: "valid",
    });
  });

  it("rejects workspace-scoped OAuth provider routes", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const providerId = await store.set(
      insertOrgProvider$,
      { orgId: fixture.orgId, type: "claude-code-oauth-token" },
      context.signal,
    );
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "claude-opus-4-7") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "claude-code-oauth-token" as const,
        credentialScope: "org" as const,
        modelProviderId: providerId,
      };
    });

    const response = await client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects incompatible provider routes", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const providerId = await store.set(
      insertOrgProvider$,
      { orgId: fixture.orgId, type: "anthropic-api-key" },
      context.signal,
    );
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "gpt-5.5") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "anthropic-api-key" as const,
        credentialScope: "org" as const,
        modelProviderId: providerId,
      };
    });

    const response = await client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects org provider routes without a provider id", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      {
        model: "glm-5.1",
        isDefault: false,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: null,
      } satisfies UpdateOrgModelPolicy,
    ];

    const response = await client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Org provider routes require a provider ID",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects duplicate model updates", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = toUpdate(listResponse.body);
    const duplicatedPolicy = updates[0]!;

    const response = await client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        policies: [
          duplicatedPolicy,
          { ...duplicatedPolicy, isDefault: false },
          ...updates.slice(1),
        ],
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: `Duplicate model "${duplicatedPolicy.model}"`,
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects updates without exactly one default model", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      return { ...policy, isDefault: false };
    });

    const response = await client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Request must include exactly one default model",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects update bodies that are not valid JSON", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await putRawModelPolicies("not-json");

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid JSON in request body",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects malformed update bodies", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await putRawModelPolicies("{}");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects incomplete update payloads", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await apiClient().update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: [] },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Request must include at least one model",
        code: "BAD_REQUEST",
      },
    });
  });
});
