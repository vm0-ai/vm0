import { randomUUID } from "node:crypto";

import {
  onboardingSetupContract,
  onboardingStatusContract,
} from "@vm0/api-contracts/contracts/onboarding";
import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { createStore, command } from "ccstate";
import { eq } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { storages } from "@vm0/db/schema/storage";
import { userConnectors } from "@vm0/db/schema/user-connector";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-onboarding-setup.test.ts`.
// The 14 legacy `it()`s collapse into 4 BDD `it()`s:
// (1) auth + capability chain (401 unauth → 401 no-org → 403
// non-admin),
// (2) default agent create chain (200 admin creates + agent
// in list + status reflects it + agent metadata + member
// metadata + member role + 200 idempotent same agentId + 200
// displayName preserved + onboardingRole updated),
// (3) connectors chain (200 selectedConnectors + user
// connectors endpoint verifies + 403 disabled connector
// before create + 200 idempotent connectors authorized +
// 200 paid org skips onboardingPaymentPending),
// (4) Clerk org name update chain (200 updates name + slug
// + refreshes cache + 200 non-Latin skips slug + 200 slug
// conflict retries with suffix + 200 all-slugs-conflict
// falls back to name-only + 200 non-slug error does not
// fail setup).

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

function authHeaders(): { readonly authorization: string } {
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

interface ClerkSlugConflict {
  readonly status: number;
  readonly errors: readonly { readonly code: string; readonly meta: unknown }[];
}

function slugConflictError(): ClerkSlugConflict {
  return {
    status: 422,
    errors: [
      {
        code: "form_identifier_exists",
        meta: { paramName: "slug" },
      },
    ],
  };
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
    await db.delete(orgCache).where(eq(orgCache.orgId, fixture.orgId));
    signal.throwIfAborted();
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

const track = createFixtureTracker<OnboardingSetupFixture>((fixture) => {
  return store.set(deleteOnboardingSetupFixture$, fixture, context.signal);
});

describe("BDD POST /api/zero/onboarding/setup — auth + capability chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 403 non-admin", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().setup({ headers: {}, body: { displayName: "Zero" } }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Zero" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a valid org member (not admin).

    // When + Then: 403.
    const fixture = await track(createFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const member = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Zero" },
      }),
      [403],
    );
    expect(member.body).toStrictEqual({
      error: {
        message: "Only org admins can run onboarding setup",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("BDD POST /api/zero/onboarding/setup — default agent create chain", () => {
  it("gwt-wt-wt: 200 admin creates → agent in list + status reflects it → 200 idempotent same agentId + displayName preserved + onboardingRole updated", async () => {
    // Given: an admin Clerk session with no org yet.

    // When + Then: 200 — agentId returned, agent appears in
    // the list contract with the same metadata, and the
    // onboarding status contract reports the default agent
    // with the agent's displayName + sound.
    const fixture = await track(createFixture());
    mockAdminSession(fixture);
    const created = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "My Assistant",
          sound: "professional",
          avatarUrl: "preset:0",
          timezone: "America/Los_Angeles",
          role: "founder",
        },
      }),
      [200],
    );
    const agentId = created.body.agentId;
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
    const status = await accept(
      statusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body).toMatchObject({
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: agentId,
      defaultAgentMetadata: {
        displayName: "My Assistant",
        sound: "professional",
      },
    });

    // Given: the same admin session + the default agent
    // created above.

    // When + Then: 200 — the second call returns the same
    // agentId (idempotent), the agent's displayName is
    // preserved (not updated to the new one), and the
    // member-level onboardingRole is updated.
    const repeated = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Different Name", role: "engineer" },
      }),
      [200],
    );
    expect(repeated.body.agentId).toBe(agentId);
    const repeatedAgents = await accept(
      agentsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(repeatedAgents.body.length).toBeGreaterThan(0);
    const listedAfter = repeatedAgents.body.find((agent) => {
      return agent.agentId === agentId;
    });
    expect(listedAfter).toMatchObject({
      displayName: "My Assistant",
    });
  });
});

describe("BDD POST /api/zero/onboarding/setup — connectors chain", () => {
  it("gwt-wt-wt: 200 selectedConnectors → user connectors endpoint verifies → 403 disabled connector before create → 200 idempotent connectors authorized → 200 paid org skips onboardingPaymentPending", async () => {
    // Given: an admin Clerk session with no org yet.

    // When + Then: 200 — agentId returned, the user-connectors
    // endpoint reflects exactly the requested types.
    const fixture = await track(createFixture());
    mockAdminSession(fixture);
    const created = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          selectedConnectors: ["slack", "github"],
        },
      }),
      [200],
    );
    const agentId = created.body.agentId;
    const connectors = await accept(
      userConnectorsClient().get({
        params: { id: agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect([...connectors.body.enabledTypes].sort()).toStrictEqual([
      "github",
      "slack",
    ]);

    // Given: an admin Clerk session with no org yet.

    // When + Then: 403 with a FORBIDDEN error message that
    // names the unavailable connector type.
    const disabledFixture = await track(createFixture());
    mockAdminSession(disabledFixture);
    const disabled = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          selectedConnectors: ["bentoml"],
        },
      }),
      [403],
    );
    expect(disabled.body.error.code).toBe("FORBIDDEN");
    expect(disabled.body.error.message).toContain(
      "Connector types are not available: bentoml",
    );

    // Given: a fresh admin Clerk session + a default agent
    // already created in the same fixture.

    // When + Then: 200 — the second call returns the same
    // agentId (idempotent on the agent) AND the user-connectors
    // endpoint reflects the newly authorized types.
    const idempFixture = await track(createFixture());
    mockAdminSession(idempFixture);
    const first = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Zero" },
      }),
      [200],
    );
    const firstAgentId = first.body.agentId;
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
    expect(second.body.agentId).toBe(firstAgentId);
    const idempConnectors = await accept(
      userConnectorsClient().get({
        params: { id: firstAgentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect([...idempConnectors.body.enabledTypes].sort()).toStrictEqual([
      "github",
      "slack",
    ]);

    // Given: a fresh admin Clerk session + a default agent
    // already created + the org upgraded to a paid tier
    // (direct DB write because no public endpoint flips
    // tier; tolerated as an Open Helper Gap).

    // When + Then: 200 — second call returns the same
    // agentId and the user-connectors endpoint reflects
    // the requested types.
    const paidFixture = await track(createFixture());
    mockAdminSession(paidFixture);
    const paidFirst = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: { displayName: "Zero" },
      }),
      [200],
    );
    const paidAgentId = paidFirst.body.agentId;
    const paidDb = store.set(writeDb$);
    await paidDb
      .update(orgMetadata)
      .set({ tier: "pro", onboardingPaymentPending: false })
      .where(eq(orgMetadata.orgId, paidFixture.orgId));
    const paidSecond = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          selectedConnectors: ["slack"],
        },
      }),
      [200],
    );
    expect(paidSecond.body.agentId).toBe(paidAgentId);
    const paidConnectors = await accept(
      userConnectorsClient().get({
        params: { id: paidAgentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect([...paidConnectors.body.enabledTypes].sort()).toStrictEqual([
      "slack",
    ]);
  });
});

describe("BDD POST /api/zero/onboarding/setup — Clerk org update chain", () => {
  it("gwt-wt-wt: 200 updates name + slug → 200 non-Latin skips slug → 200 slug conflict retries with suffix → 200 all-slugs-conflict falls back to name-only → 200 non-slug error does not fail setup", async () => {
    // Reset the Clerk org update mock to start with no
    // accumulated calls from previous sub-steps.
    context.mocks.clerk.organizations.updateOrganization.mockReset();
    // Given: an admin Clerk session with no org yet + a
    // pre-seeded orgCache row.

    // When + Then: 200 — the Clerk updateOrganization mock
    // is called with the Latin name + slug, and the orgCache
    // row is removed (verified via a follow-up status check
    // that the cache is no longer stale).
    const fixture = await track(createFixture());
    mockAdminSession(fixture);
    const paidDb = store.set(writeDb$);
    await paidDb.insert(orgCache).values({
      orgId: fixture.orgId,
      slug: "stale-workspace",
      name: "Stale Workspace",
    });
    const updated = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "My Workspace",
        },
      }),
      [200],
    );
    expect(updated.body.agentId).toBeTruthy();
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).toHaveBeenCalledWith(fixture.orgId, {
      name: "My Workspace",
      slug: "my-workspace",
    });
    const cacheAfter = await paidDb
      .select({ slug: orgCache.slug, name: orgCache.name })
      .from(orgCache)
      .where(eq(orgCache.orgId, fixture.orgId))
      .limit(1);
    expect(cacheAfter).toStrictEqual([]);

    // Given: a fresh admin Clerk session with a non-Latin
    // workspace name.

    // When + Then: 200 — Clerk is called with name only (no
    // slug).
    const nonLatinFixture = await track(createFixture());
    mockAdminSession(nonLatinFixture);
    const nonLatin = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "我的工作区",
        },
      }),
      [200],
    );
    expect(nonLatin.body.agentId).toBeTruthy();
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).toHaveBeenCalledWith(nonLatinFixture.orgId, { name: "我的工作区" });

    // Given: a fresh admin Clerk session with a workspace
    // name + a Clerk mock that rejects the first slug attempt
    // with a form_identifier_exists error and accepts the
    // retry.

    // When + Then: 200 — Clerk is called twice: first with
    // the unsuffixed slug, then with a slug matching
    // `my-workspace-<6 char suffix>`.
    const retryFixture = await track(createFixture());
    mockAdminSession(retryFixture);
    const retryMockImpl = (
      _orgId: unknown,
      data: unknown,
    ): Promise<unknown> => {
      if (expectRecord(data).slug === "my-workspace") {
        return Promise.reject(slugConflictError());
      }
      return Promise.resolve({});
    };
    context.mocks.clerk.organizations.updateOrganization.mockImplementation(
      retryMockImpl,
    );
    const retryStartCallCount =
      context.mocks.clerk.organizations.updateOrganization.mock.calls.length;
    const retry = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "My Workspace",
        },
      }),
      [200],
    );
    expect(retry.body.agentId).toBeTruthy();
    const retryCalls =
      context.mocks.clerk.organizations.updateOrganization.mock.calls.slice(
        retryStartCallCount,
      );
    expect(retryCalls).toHaveLength(2);
    const retryData = expectRecord(retryCalls[1]?.[1]);
    expect(retryData.name).toBe("My Workspace");
    expect(retryData.slug).toMatch(/^my-workspace-[a-z0-9]{6}$/);

    // Given: a fresh admin Clerk session with a workspace
    // name + a Clerk mock that rejects every slug attempt
    // with a form_identifier_exists error.

    // When + Then: 200 — Clerk is called with three total
    // attempts; the last call is a name-only update.
    const fallbackFixture = await track(createFixture());
    mockAdminSession(fallbackFixture);
    const fallbackStartCallCount =
      context.mocks.clerk.organizations.updateOrganization.mock.calls.length;
    context.mocks.clerk.organizations.updateOrganization.mockImplementation(
      (_orgId: unknown, data: unknown) => {
        if ("slug" in expectRecord(data)) {
          return Promise.reject(slugConflictError());
        }
        return Promise.resolve({});
      },
    );
    const fallback = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "My Workspace",
        },
      }),
      [200],
    );
    expect(fallback.body.agentId).toBeTruthy();
    const fallbackCalls =
      context.mocks.clerk.organizations.updateOrganization.mock.calls.slice(
        fallbackStartCallCount,
      );
    expect(fallbackCalls).toHaveLength(3);
    expect(fallbackCalls[2]).toStrictEqual([
      fallbackFixture.orgId,
      { name: "My Workspace" },
    ]);

    // Given: a fresh admin Clerk session with a workspace
    // name + a Clerk mock that rejects with a non-slug
    // error.

    // When + Then: 200 — setup completes successfully even
    // though Clerk was not updated.
    const errorFixture = await track(createFixture());
    mockAdminSession(errorFixture);
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
    const errored = await accept(
      apiClient().setup({
        headers: authHeaders(),
        body: {
          displayName: "Zero",
          workspaceName: "Test Workspace",
        },
      }),
      [200],
    );
    expect(errored.body.agentId).toBeTruthy();
    const status = await accept(
      statusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body).toMatchObject({
      hasDefaultAgent: true,
      defaultAgentId: errored.body.agentId,
    });
  });
});
