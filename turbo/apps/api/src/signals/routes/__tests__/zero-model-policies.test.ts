import { randomUUID } from "node:crypto";

import { createStore, command } from "ccstate";
import {
  SUPPORTED_RUN_MODELS,
  type ModelProviderType,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
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
      enabled: policy.enabled,
      sortOrder: policy.sortOrder,
      defaultProviderType: policy.defaultProviderType,
      credentialScope: policy.credentialScope,
      modelProviderId: policy.modelProviderId,
    };
  });
}

function apiClient() {
  return setupApp({ context })(zeroModelPoliciesMainContract);
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
  it("hides model policy controls while the feature switch is off", async () => {
    const fixture = await seedFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await apiClient().list({
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("lists seeded curated models in rank order when enabled", async () => {
    const fixture = await seedFixture({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });
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
    ).toStrictEqual(SUPPORTED_RUN_MODELS);
    expect(response.body.policies[0]).toMatchObject({
      enabled: true,
      sortOrder: 0,
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
    });
    expect(response.body.workspaceDefaultModel).toBe(SUPPORTED_RUN_MODELS[0]);
  });

  it("requires admins for policy reads and writes", async () => {
    const fixture = await seedFixture({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = apiClient();
    const listResponse = await client.list({
      headers: { authorization: "Bearer clerk-session" },
    });
    const updateResponse = await client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: [] },
    });

    expect(listResponse.status).toBe(403);
    expect(updateResponse.status).toBe(403);
  });

  it("persists enablement and ordering and updates the workspace default", async () => {
    const fixture = await seedFixture({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const updates = toUpdate(listResponse.body);

    updates[0] = { ...updates[0]!, enabled: false, sortOrder: 1 };
    updates[1] = { ...updates[1]!, sortOrder: 0 };

    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { policies: updates },
      }),
      [200],
    );

    const [firstPolicy, secondPolicy] = response.body.policies;
    expect(firstPolicy).toBeDefined();
    expect(secondPolicy).toBeDefined();
    expect(firstPolicy!.model).toBe(SUPPORTED_RUN_MODELS[1]);
    expect(secondPolicy!.model).toBe(SUPPORTED_RUN_MODELS[0]);
    expect(secondPolicy!.enabled).toBeFalsy();
    expect(response.body.workspaceDefaultModel).toBe(SUPPORTED_RUN_MODELS[1]);
  });

  it("allows compatible org provider routes", async () => {
    const fixture = await seedFixture({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });
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
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "glm-5.1") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "openrouter-api-key" as const,
        credentialScope: "org" as const,
        modelProviderId: providerId,
      };
    });

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

  it("rejects incompatible provider routes", async () => {
    const fixture = await seedFixture({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });
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

  it("rejects incomplete update payloads", async () => {
    const fixture = await seedFixture({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await apiClient().update({
      headers: { authorization: "Bearer clerk-session" },
      body: { policies: [] },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});
