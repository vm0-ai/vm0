import { randomUUID } from "node:crypto";

import {
  onboardingSetupContract,
  onboardingStatusContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { createStore, command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { storages } from "@vm0/db/schema/storage";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface OnboardingSetupFixture {
  readonly orgId: string;
  readonly userId: string;
}

function apiClient() {
  return setupApp({ context })(onboardingSetupContract);
}

function statusClient() {
  return setupApp({ context })(onboardingStatusContract);
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function userConnectorsClient() {
  return setupApp({ context })(zeroUserConnectorsContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createFixture(): Promise<OnboardingSetupFixture> {
  return Promise.resolve({
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  });
}

function mockAdminSession(fixture: OnboardingSetupFixture): void {
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
}

function slugConflictError() {
  return Object.assign(new Error("Unprocessable Entity"), {
    status: 422,
    errors: [
      {
        code: "form_identifier_exists",
        message: "That slug is already in use",
        meta: { paramName: "slug" },
      },
    ],
  });
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return value as Record<string, unknown>;
}

const deleteOnboardingSetupFixture$ = command(
  async (
    { set },
    fixture: OnboardingSetupFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(userConnectors)
      .where(eq(userConnectors.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(modelProviders)
      .where(eq(modelProviders.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db.delete(storages).where(eq(storages.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

async function readAgent(agentId: string) {
  const db = store.set(writeDb$);
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      orgId: zeroAgents.orgId,
      owner: zeroAgents.owner,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
      sound: zeroAgents.sound,
      avatarUrl: zeroAgents.avatarUrl,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId));
  return agent;
}

async function readComposeHead(agentId: string): Promise<string | null> {
  const db = store.set(writeDb$);
  const [compose] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentId));
  return compose?.headVersionId ?? null;
}

async function readOrgMetadata(orgId: string) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      defaultAgentId: orgMetadata.defaultAgentId,
      credits: orgMetadata.credits,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId));
  return row;
}

async function readMemberMetadata(orgId: string, userId: string) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      timezone: orgMembersMetadata.timezone,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    );
  return row;
}

async function readMemberRole(orgId: string, userId: string) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      role: orgMembersCache.role,
    })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    );
  return row;
}

async function readVm0Provider(orgId: string) {
  const db = store.set(writeDb$);
  const [provider] = await db
    .select({
      userId: modelProviders.userId,
      type: modelProviders.type,
      isDefault: modelProviders.isDefault,
      selectedModel: modelProviders.selectedModel,
      secretId: modelProviders.secretId,
      authMethod: modelProviders.authMethod,
    })
    .from(modelProviders)
    .where(
      and(eq(modelProviders.orgId, orgId), eq(modelProviders.type, "vm0")),
    );
  return provider;
}

async function readStarterGrants(orgId: string) {
  const db = store.set(writeDb$);
  return await db
    .select({
      source: creditExpiresRecord.source,
      amount: creditExpiresRecord.amount,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, orgId));
}

async function readConnectorTypes(
  orgId: string,
  userId: string,
  agentId: string,
): Promise<string[]> {
  const db = store.set(writeDb$);
  const rows = await db
    .select({ connectorType: userConnectors.connectorType })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, orgId),
        eq(userConnectors.userId, userId),
        eq(userConnectors.agentId, agentId),
      ),
    );
  return rows
    .map((row) => {
      return row.connectorType;
    })
    .sort();
}

async function countAgents(orgId: string): Promise<number> {
  const db = store.set(writeDb$);
  const rows = await db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(eq(zeroAgents.orgId, orgId));
  return rows.length;
}

describe("POST /api/zero/onboarding/setup", () => {
  const track = createFixtureTracker<OnboardingSetupFixture>((fixture) => {
    return store.set(deleteOnboardingSetupFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().setup({ headers: {}, body: { displayName: "Zero" } }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Zero" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when an org member runs setup", async () => {
    const fixture = await track(createFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Zero" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can run onboarding setup",
        code: "FORBIDDEN",
      },
    });
  });

  it("creates the default agent and onboarding state for an admin", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "My Assistant",
          sound: "professional",
          avatarUrl: "preset:0",
          timezone: "America/Los_Angeles",
        },
      }),
      [200],
    );

    const agentId = response.body.agentId;
    await expect(readAgent(agentId)).resolves.toMatchObject({
      id: agentId,
      orgId: fixture.orgId,
      owner: fixture.userId,
      displayName: "My Assistant",
      sound: "professional",
      avatarUrl: "preset:0",
    });
    await expect(readComposeHead(agentId)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(readOrgMetadata(fixture.orgId)).resolves.toMatchObject({
      defaultAgentId: agentId,
      credits: 10_000,
    });
    const agents = await accept(
      agentsClient().list({ headers: authHeaders() }),
      [200],
    );
    const listedAgent = agents.body.find((agent) => {
      return agent.agentId === agentId;
    });
    expect(listedAgent).toMatchObject({
      agentId,
      ownerId: fixture.userId,
      displayName: "My Assistant",
      sound: "professional",
      avatarUrl: "preset:0",
    });
    await expect(
      readMemberMetadata(fixture.orgId, fixture.userId),
    ).resolves.toStrictEqual({
      timezone: "America/Los_Angeles",
    });
    await expect(
      readMemberRole(fixture.orgId, fixture.userId),
    ).resolves.toStrictEqual({
      role: "admin",
    });
    await expect(readVm0Provider(fixture.orgId)).resolves.toMatchObject({
      userId: "__org__",
      type: "vm0",
      isDefault: false,
      selectedModel: "claude-sonnet-4-6",
      secretId: null,
      authMethod: null,
    });
    await expect(readStarterGrants(fixture.orgId)).resolves.toStrictEqual([
      { source: "starter_grant", amount: 10_000, remaining: 10_000 },
    ]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(2);

    const status = await accept(
      statusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body).toStrictEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: agentId,
      defaultAgentMetadata: {
        displayName: "My Assistant",
        sound: "professional",
      },
    });
  });

  it("returns the existing default agent on repeated setup calls", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);

    const first = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Zero" },
      }),
      [200],
    );
    const second = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Different Name" },
      }),
      [200],
    );

    expect(second.body.agentId).toBe(first.body.agentId);
    await expect(countAgents(fixture.orgId)).resolves.toBe(1);
    await expect(readAgent(first.body.agentId)).resolves.toMatchObject({
      displayName: "Zero",
    });
  });

  it("sets selected connectors for the new agent", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          selectedConnectors: ["slack", "github"],
        },
      }),
      [200],
    );

    await expect(
      readConnectorTypes(fixture.orgId, fixture.userId, response.body.agentId),
    ).resolves.toStrictEqual(["github", "slack"]);
    const connectors = await accept(
      userConnectorsClient().get({
        params: { id: response.body.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(connectors.body.enabledTypes.sort()).toStrictEqual([
      "github",
      "slack",
    ]);
  });

  it("authorizes connectors on a repeated setup call to an existing default agent", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);

    // First call: create the workspace + default agent, no connectors.
    const first = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Zero" },
      }),
      [200],
    );
    const agentId = first.body.agentId;

    // Second call (the skippable step 2): connectors get authorized to the
    // existing default agent even though setup is idempotent on the agent.
    const second = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          selectedConnectors: ["slack", "github"],
        },
      }),
      [200],
    );

    expect(second.body.agentId).toBe(agentId);
    await expect(countAgents(fixture.orgId)).resolves.toBe(1);
    await expect(
      readConnectorTypes(fixture.orgId, fixture.userId, agentId),
    ).resolves.toStrictEqual(["github", "slack"]);
    const connectors = await accept(
      userConnectorsClient().get({
        params: { id: agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(connectors.body.enabledTypes.sort()).toStrictEqual([
      "github",
      "slack",
    ]);
  });

  it("updates Clerk org name and slug for valid Latin workspace names", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "My Workspace",
        },
      }),
      [200],
    );

    expect(response.body.agentId).toBeTruthy();
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).toHaveBeenCalledWith(fixture.orgId, {
      name: "My Workspace",
      slug: "my-workspace",
    });
  });

  it("updates Clerk org name only for non-Latin workspace names", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "我的工作区",
        },
      }),
      [200],
    );

    expect(response.body.agentId).toBeTruthy();
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).toHaveBeenCalledWith(fixture.orgId, { name: "我的工作区" });
  });

  it("retries Clerk org slug updates with a suffixed slug on conflict", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);
    context.mocks.clerk.organizations.updateOrganization.mockImplementation(
      (_orgId: unknown, data: unknown) => {
        if (expectRecord(data).slug === "my-workspace") {
          return Promise.reject(slugConflictError());
        }
        return Promise.resolve({});
      },
    );

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "My Workspace",
        },
      }),
      [200],
    );

    expect(response.body.agentId).toBeTruthy();
    const calls =
      context.mocks.clerk.organizations.updateOrganization.mock.calls;
    expect(calls).toHaveLength(2);
    const retry = expectRecord(calls[1]?.[1]);
    expect(retry.name).toBe("My Workspace");
    expect(retry.slug).toMatch(/^my-workspace-[a-z0-9]{6}$/);
  });

  it("falls back to Clerk org name-only update when all slugs conflict", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);
    context.mocks.clerk.organizations.updateOrganization.mockImplementation(
      (_orgId: unknown, data: unknown) => {
        if ("slug" in expectRecord(data)) {
          return Promise.reject(slugConflictError());
        }
        return Promise.resolve({});
      },
    );

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "My Workspace",
        },
      }),
      [200],
    );

    expect(response.body.agentId).toBeTruthy();
    const calls =
      context.mocks.clerk.organizations.updateOrganization.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[2]).toStrictEqual([fixture.orgId, { name: "My Workspace" }]);
  });

  it("does not fail setup when Clerk org update fails for a non-slug error", async () => {
    const fixture = await track(createFixture());
    mockAdminSession(fixture);
    context.mocks.clerk.organizations.updateOrganization.mockRejectedValue(
      Object.assign(new Error("Unprocessable Entity"), {
        status: 422,
        errors: [
          {
            code: "form_param_value_invalid",
            message: "Name is invalid",
            meta: { paramName: "name" },
          },
        ],
      }),
    );

    const response = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "Test Workspace",
        },
      }),
      [200],
    );

    expect(response.body.agentId).toBeTruthy();
    await expect(readOrgMetadata(fixture.orgId)).resolves.toMatchObject({
      defaultAgentId: response.body.agentId,
    });
  });
});
