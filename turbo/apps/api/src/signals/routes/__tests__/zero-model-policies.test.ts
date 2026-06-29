import { randomUUID } from "node:crypto";

import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  DEFAULT_ORG_MODEL_POLICY_MODELS,
  type ModelProviderType,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../external/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";

type ModelPolicyFixture = ApiTestUser & { readonly orgId: string };

const context = testContext();
const mocks = createZeroRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const runsApi = createRunsAutomationsApi(context);
const MODEL_POLICIES_PATH = "/api/zero/model-policies";

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

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

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function useSession(
  fixture: ModelPolicyFixture,
  orgRole: "org:admin" | "org:member" = "org:admin",
): void {
  mocks.clerk.session(fixture.userId, fixture.orgId, orgRole);
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

function seedFixture(): ModelPolicyFixture {
  const actor = authOrgApi.user();
  if (!actor.orgId) {
    throw new Error("Expected model policy fixture to have an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

async function createOrgProvider(
  fixture: ModelPolicyFixture,
  type: ModelProviderType,
): Promise<string> {
  const { providerId } = await runsApi.createOrgModelProvider(fixture, {
    type,
    secret: "test-model-provider-secret",
  });
  return providerId;
}

async function makeLimitedFreeWorkspace(
  fixture: ModelPolicyFixture,
): Promise<void> {
  authOrgApi.acceptAgentStorageWrites();
  const setup = await authOrgApi.setupOnboarding(fixture, {
    displayName: "BDD Model Policy Agent",
  });
  if (setup.status !== 200 && setup.status !== 409) {
    throw new Error(
      `Expected onboarding setup to succeed, got ${setup.status}`,
    );
  }
  const completed = await authOrgApi.completeLimitedFreeOnboarding(fixture, {
    credits: 1000,
    expiresAt: null,
  });
  if (completed.status !== 200) {
    throw new Error(
      `Expected limited-free onboarding to succeed, got ${completed.status}`,
    );
  }
}

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
    const fixture = await seedFixture();
    mocks.clerk.session(fixture.userId, null);
    const client = apiClient();

    const listResponse = await client.list({
      headers: authHeaders(),
    });
    const updateResponse = await client.update({
      headers: authHeaders(),
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
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
  });

  it("lists seeded curated models and the explicit default when enabled", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
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

  it("lists restricted policies for limited-free-1 workspace UI gating", async () => {
    const fixture = await seedFixture();
    await makeLimitedFreeWorkspace(fixture);
    useSession(fixture);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
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

  it("allows members to read policy controls", async () => {
    const fixture = await seedFixture();
    useSession(fixture, "org:member");

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
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
    const fixture = await seedFixture();
    authOrgApi.mockClerkOrg(fixture);
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
    const fixture = await seedFixture();
    useSession(fixture, "org:member");

    const response = await apiClient().update({
      headers: authHeaders(),
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
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
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
        headers: authHeaders(),
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
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const removedModel = DEFAULT_ORG_MODEL_POLICY_MODELS.find((model) => {
      return model !== DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    });
    if (!removedModel) {
      throw new Error("Default policy seed must include a non-default model");
    }
    const updates = toUpdate(listResponse.body).filter((policy) => {
      return policy.model !== removedModel;
    });

    const updateResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: updates },
      }),
      [200],
    );
    const secondListResponse = await accept(
      client.list({ headers: authHeaders() }),
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
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = [
      ...toUpdate(listResponse.body),
      makeVm0Policy("claude-opus-4-6"),
    ];

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: updates },
      }),
      [200],
    );

    expect(
      response.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual([
      "claude-opus-4-8",
      "claude-opus-4-6",
      ...DEFAULT_ORG_MODEL_POLICY_MODELS.slice(1),
    ]);
  });

  it("rejects restricted policy writes for limited-free-1 workspaces", async () => {
    const fixture = await seedFixture();
    await makeLimitedFreeWorkspace(fixture);
    useSession(fixture);

    const response = await apiClient().update({
      headers: authHeaders(),
      body: {
        policies: [
          makeVm0Policy("kimi-k2.7-code", true),
          makeVm0Policy("gpt-5.5"),
        ],
      },
    });
    const afterRejected = await accept(
      apiClient().list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.status).toBe(402);
    expect(response.body).toStrictEqual({
      error: {
        message:
          "Insufficient credits. Add credits or configure your own API key to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    expect(afterRejected.body.workspaceDefaultModel).toBe(
      DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
    );
    expect(
      afterRejected.body.policies
        .filter((policy) => {
          return policy.isDefault;
        })
        .map((policy) => {
          return policy.model;
        }),
    ).toStrictEqual([DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL]);
  });

  it("allows compatible GLM 5.2 org provider routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const openRouterProviderId = await createOrgProvider(
      fixture,
      "openrouter-api-key",
    );
    const zaiProviderId = await createOrgProvider(fixture, "zai-api-key");
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "glm-5.2") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "openrouter-api-key" as const,
        credentialScope: "org" as const,
        modelProviderId: openRouterProviderId,
      };
    });

    const openRouterResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: updates },
      }),
      [200],
    );
    const openRouterGlm = openRouterResponse.body.policies.find((policy) => {
      return policy.model === "glm-5.2";
    });

    expect(openRouterGlm).toMatchObject({
      defaultProviderType: "openrouter-api-key",
      credentialScope: "org",
      modelProviderId: openRouterProviderId,
      routeStatus: "valid",
    });

    const zaiUpdates = toUpdate(openRouterResponse.body).map((policy) => {
      if (policy.model !== "glm-5.2") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "zai-api-key" as const,
        modelProviderId: zaiProviderId,
      };
    });
    const zaiResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: { policies: zaiUpdates },
      }),
      [200],
    );
    const zaiGlm = zaiResponse.body.policies.find((policy) => {
      return policy.model === "glm-5.2";
    });

    expect(zaiGlm).toMatchObject({
      defaultProviderType: "zai-api-key",
      credentialScope: "org",
      modelProviderId: zaiProviderId,
      routeStatus: "valid",
    });
  });

  it("allows compatible member OAuth provider routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "claude-opus-4-8") {
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
        headers: authHeaders(),
        body: { policies: updates },
      }),
      [200],
    );
    const opus = response.body.policies.find((policy) => {
      return policy.model === "claude-opus-4-8";
    });

    expect(opus).toMatchObject({
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      routeStatus: "valid",
    });
  });

  it("rejects workspace-scoped OAuth provider routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const providerId = await createOrgProvider(
      fixture,
      "claude-code-oauth-token",
    );
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "claude-opus-4-8") {
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
      headers: authHeaders(),
      body: { policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects incompatible provider routes", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const providerId = await createOrgProvider(fixture, "anthropic-api-key");
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "glm-5.2") {
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
      headers: authHeaders(),
      body: { policies: updates },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects org provider routes without a provider id", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      if (policy.model !== "glm-5.2") {
        return policy;
      }
      return {
        ...policy,
        defaultProviderType: "openrouter-api-key" as const,
        credentialScope: "org" as const,
        modelProviderId: null,
      };
    });

    const response = await client.update({
      headers: authHeaders(),
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
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body);
    const duplicatedPolicy = updates[0]!;

    const response = await client.update({
      headers: authHeaders(),
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
    const fixture = await seedFixture();
    useSession(fixture);
    const client = apiClient();
    const listResponse = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );
    const updates = toUpdate(listResponse.body).map((policy) => {
      return { ...policy, isDefault: false };
    });

    const response = await client.update({
      headers: authHeaders(),
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
    const fixture = await seedFixture();
    useSession(fixture);

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
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await putRawModelPolicies("{}");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects removed model policy updates", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await putRawModelPolicies(
      JSON.stringify({
        policies: [
          {
            model: "claude-haiku-4-5",
            isDefault: true,
            defaultProviderType: "vm0",
            credentialScope: "org",
            modelProviderId: null,
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects incomplete update payloads", async () => {
    const fixture = await seedFixture();
    useSession(fixture);

    const response = await apiClient().update({
      headers: authHeaders(),
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
