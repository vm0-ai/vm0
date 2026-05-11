import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { zeroAgentPermissionPoliciesContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { seedCompose$ } from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface OrgUser {
  readonly orgId: string;
  readonly userId: string;
}

function uniqueOrgUser(prefix: string): OrgUser {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

function slackAllow() {
  return {
    slack: { policies: { "channels:read": "allow" } },
  } as const;
}

async function readStoredPolicies(agentId: string) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      permissionPolicies: zeroAgents.permissionPolicies,
      unknownPermissionPolicies: zeroAgents.unknownPermissionPolicies,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  return row;
}

describe("PUT /api/zero/permission-policies", () => {
  it("persists permission policies for an agent", async () => {
    const fixture = uniqueOrgUser("zpp-persist");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const policies = {
      slack: {
        policies: { "channels:read": "allow", "chat:write": "deny" },
      },
    } as const;

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await client.update({
      body: { agentId, policies },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.permissionPolicies).toStrictEqual(policies);
    expect(response.body.agentId).toBe(agentId);
  });

  it("persists policies across reads (DB read-after-write)", async () => {
    const fixture = uniqueOrgUser("zpp-persist-db");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const policies = {
      slack: {
        policies: { "channels:read": "allow", "chat:write": "ask" },
      },
    } as const;

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await client.update({
      body: { agentId, policies },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);

    // Direct DB SELECT verifies the row was persisted, independent of the
    // PUT response body. Mirrors web case "should persist policies across reads".
    // The DB stores the flat RawPermissionPolicies form (no `policies` wrapper);
    // toFirewallPolicies reconstructs the nested wire shape on read.
    const stored = await readStoredPolicies(agentId);
    expect(stored?.permissionPolicies).toStrictEqual({
      slack: { "channels:read": "allow", "chat:write": "ask" },
    });
  });

  it("overwrites previous policies on a second PUT", async () => {
    const fixture = uniqueOrgUser("zpp-overwrite");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);

    await client.update({
      body: {
        agentId,
        policies: {
          slack: { policies: { "channels:read": "allow" } },
        },
      },
      headers: { authorization: "Bearer clerk-session" },
    });

    const second = {
      slack: { policies: { "channels:read": "deny" } },
    } as const;
    const response = await client.update({
      body: { agentId, policies: second },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.permissionPolicies).toStrictEqual(second);
  });

  it("allows an org admin to update another user's agent", async () => {
    const ownerFixture = uniqueOrgUser("zpp-owner");
    const adminFixture = {
      orgId: ownerFixture.orgId,
      userId: `user_zpp-other-admin_${randomUUID().slice(0, 8)}`,
    };
    await store.set(
      seedOrgMembership$,
      {
        orgId: ownerFixture.orgId,
        userId: ownerFixture.userId,
        role: "member",
      },
      context.signal,
    );
    await store.set(
      seedOrgMembership$,
      {
        orgId: adminFixture.orgId,
        userId: adminFixture.userId,
        role: "admin",
        seedOrgCache: false,
      },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );
    mocks.clerk.session(adminFixture.userId, adminFixture.orgId);

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await client.update({
      body: { agentId, policies: slackAllow() },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.permissionPolicies).toStrictEqual(slackAllow());
  });

  it("returns 403 for a non-owner member", async () => {
    const ownerFixture = uniqueOrgUser("zpp-owner2");
    const memberFixture = {
      orgId: ownerFixture.orgId,
      userId: `user_zpp-other-member_${randomUUID().slice(0, 8)}`,
    };
    await store.set(
      seedOrgMembership$,
      {
        orgId: ownerFixture.orgId,
        userId: ownerFixture.userId,
        role: "member",
      },
      context.signal,
    );
    await store.set(
      seedOrgMembership$,
      {
        orgId: memberFixture.orgId,
        userId: memberFixture.userId,
        role: "member",
        seedOrgCache: false,
      },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );
    mocks.clerk.session(
      memberFixture.userId,
      memberFixture.orgId,
      "org:member",
    );

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await accept(
      client.update({
        body: { agentId, policies: slackAllow() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("update permission policies");
  });

  it("allows the agent owner with member role to update policies", async () => {
    const fixture = uniqueOrgUser("zpp-owner-member");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "member" },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await client.update({
      body: { agentId, policies: slackAllow() },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.permissionPolicies).toStrictEqual(slackAllow());
  });

  it("returns 400 VALIDATION_ERROR for an unknown connector ref", async () => {
    const fixture = uniqueOrgUser("zpp-unknown-conn");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await accept(
      client.update({
        body: {
          agentId,
          policies: {
            "nonexistent-connector": {
              policies: { "perm:read": "allow" },
            },
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.message).toContain("nonexistent-connector");
  });

  it("returns 400 VALIDATION_ERROR for an unknown permission name", async () => {
    const fixture = uniqueOrgUser("zpp-unknown-perm");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await accept(
      client.update({
        body: {
          agentId,
          policies: {
            slack: { policies: { "totally-fake-permission": "allow" } },
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.message).toContain("totally-fake-permission");
  });

  it("returns 404 for a nonexistent agent", async () => {
    const fixture = uniqueOrgUser("zpp-missing");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await accept(
      client.update({
        body: {
          agentId: "00000000-0000-0000-0000-000000000000",
          policies: slackAllow(),
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 without auth", async () => {
    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await accept(
      client.update({
        body: {
          agentId: "00000000-0000-4000-8000-000000000001",
          policies: {},
        },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await accept(
      client.update({
        body: {
          agentId: "00000000-0000-4000-8000-000000000001",
          policies: {},
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("accepts empty policies and stores null", async () => {
    const fixture = uniqueOrgUser("zpp-empty");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await client.update({
      body: { agentId, policies: {} },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.permissionPolicies).toBeNull();
  });

  it("returns the full agent response shape", async () => {
    const fixture = uniqueOrgUser("zpp-shape");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    const { agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    const response = await client.update({
      body: { agentId, policies: slackAllow() },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toMatchObject({
      agentId,
      ownerId: fixture.userId,
      description: null,
      displayName: null,
      sound: null,
      avatarUrl: null,
      permissionPolicies: slackAllow(),
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
    });
  });

  it("isolates policies between different agents in the same org", async () => {
    const fixture = uniqueOrgUser("zpp-isolation");
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      context.signal,
    );
    const agent1 = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const agent2 = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const policies1 = {
      slack: { policies: { "channels:read": "allow" } },
    } as const;
    const policies2 = {
      slack: { policies: { "channels:read": "deny" } },
    } as const;

    const client = setupApp({ context })(zeroAgentPermissionPoliciesContract);
    await client.update({
      body: { agentId: agent1.agentId, policies: policies1 },
      headers: { authorization: "Bearer clerk-session" },
    });
    const second = await client.update({
      body: { agentId: agent2.agentId, policies: policies2 },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(second.status).toBe(200);

    const stored1 = await readStoredPolicies(agent1.agentId);
    const stored2 = await readStoredPolicies(agent2.agentId);
    expect(stored1?.permissionPolicies).not.toBeNull();
    expect(stored2?.permissionPolicies).not.toBeNull();
    expect(stored1?.permissionPolicies).not.toStrictEqual(
      stored2?.permissionPolicies,
    );
  });
});
