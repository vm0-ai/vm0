import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../../agents/route";
import { GET } from "../../agents/[id]/route";
import { PUT as putFirewallPolicies } from "../route";
import {
  createTestRequest,
  createTestCliToken,
  insertOrgMembersCacheEntry,
  seedSeedSkills,
  clearSkillsData,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

let testCliToken: string;
let testOrgSlug: string;
let testOrgId: string;
let testUserId: string;

function postAgent(
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return POST(
    createTestRequest(`http://localhost:3000/api/zero/agents${orgParam}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function getAgent(name: string, token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${name}${orgParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function putPolicies(
  agentId: string,
  body: Record<string, unknown>,
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return putFirewallPolicies(
    createTestRequest(
      `http://localhost:3000/api/zero/firewall-policies${orgParam}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId, ...body }),
      },
    ),
  );
}

describe("PUT /api/zero/firewall-policies", () => {
  beforeEach(async () => {
    context.setupMocks();
    await clearSkillsData();
    await seedSeedSkills();
    const user = await context.setupUser();
    testUserId = user.userId;
    testOrgId = user.orgId;
    testCliToken = await createTestCliToken(user.userId);
    testOrgSlug = `org-${user.userId.slice(-8)}`;

    // Default test user is admin
    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: testUserId,
      role: "admin",
    });
  });

  it("should persist firewall policies for an agent", async () => {
    const createRes = await postAgent(
      { connectors: [] },
      testCliToken,
      testOrgSlug,
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const policies = {
      github: { "issues:read": "allow", "issues:write": "deny" },
    };

    const response = await putPolicies(
      created.agentId,
      { policies },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.firewallPolicies).toStrictEqual(policies);
    expect(data.agentId).toBe(created.agentId);
  });

  it("should persist policies across reads", async () => {
    const created = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();

    const policies = {
      slack: { "channels:read": "allow", "chat:write": "ask" },
    };

    await putPolicies(created.agentId, { policies }, testCliToken, testOrgSlug);

    // Read back via GET
    const getRes = await getAgent(created.agentId, testCliToken, testOrgSlug);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.firewallPolicies).toStrictEqual(policies);
  });

  it("should overwrite previous policies", async () => {
    const created = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();

    const first = { github: { "issues:read": "allow" } };
    await putPolicies(
      created.agentId,
      { policies: first },
      testCliToken,
      testOrgSlug,
    );

    const second = { slack: { "channels:read": "deny" } };
    const response = await putPolicies(
      created.agentId,
      { policies: second },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.firewallPolicies).toStrictEqual(second);
  });

  it("should return 403 for non-admin users", async () => {
    const created = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();

    // Create a non-admin user
    const member = await context.setupUser({ prefix: "member-user" });
    const memberToken = await createTestCliToken(member.userId);

    // Grant member role in the same org
    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: member.userId,
      role: "member",
    });

    const response = await putPolicies(
      created.agentId,
      { policies: { github: { "issues:read": "allow" } } },
      memberToken,
      testOrgSlug,
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 for unknown firewall ref", async () => {
    const created = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();

    const response = await putPolicies(
      created.agentId,
      { policies: { "nonexistent-firewall": { "perm:read": "allow" } } },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(data.error.message).toContain("nonexistent-firewall");
  });

  it("should return 400 for unknown permission name", async () => {
    const created = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();

    const response = await putPolicies(
      created.agentId,
      { policies: { github: { "totally-fake-permission": "allow" } } },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(data.error.message).toContain("totally-fake-permission");
  });

  it("should return 404 for nonexistent agent", async () => {
    const response = await putPolicies(
      "00000000-0000-0000-0000-000000000000",
      { policies: { github: { "issues:read": "allow" } } },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 401 without auth", async () => {
    mockClerk({ userId: null });

    const response = await putPolicies(
      "00000000-0000-4000-8000-000000000001",
      { policies: {} },
      "no-token",
    );

    expect(response.status).toBe(401);
  });

  it("should accept empty policies", async () => {
    const created = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();

    const response = await putPolicies(
      created.agentId,
      { policies: {} },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.firewallPolicies).toStrictEqual({});
  });

  it("should return firewallPolicies as null for new agents", async () => {
    const createRes = await postAgent(
      { connectors: [] },
      testCliToken,
      testOrgSlug,
    );
    expect(createRes.status).toBe(201);
    const data = await createRes.json();
    expect(data.firewallPolicies).toBeNull();
  });

  it("should return full agent response shape", async () => {
    const created = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();

    const policies = { github: { "issues:read": "allow" } };
    const response = await putPolicies(
      created.agentId,
      { policies },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({
      agentId: created.agentId,
      description: expect.toBeOneOf([null, expect.any(String)]),
      displayName: expect.toBeOneOf([null, expect.any(String)]),
      sound: expect.toBeOneOf([null, expect.any(String)]),
      connectors: expect.any(Array),
      firewallPolicies: policies,
    });
  });

  it("should isolate policies between different agents", async () => {
    const agent1 = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();
    const agent2 = await (
      await postAgent({ connectors: [] }, testCliToken, testOrgSlug)
    ).json();

    const policies1 = { github: { "issues:read": "allow" } };
    const policies2 = { slack: { "channels:read": "deny" } };

    await putPolicies(
      agent1.agentId,
      { policies: policies1 },
      testCliToken,
      testOrgSlug,
    );
    await putPolicies(
      agent2.agentId,
      { policies: policies2 },
      testCliToken,
      testOrgSlug,
    );

    const get1 = await getAgent(agent1.agentId, testCliToken, testOrgSlug);
    const get2 = await getAgent(agent2.agentId, testCliToken, testOrgSlug);

    expect((await get1.json()).firewallPolicies).toStrictEqual(policies1);
    expect((await get2.json()).firewallPolicies).toStrictEqual(policies2);
  });
});
