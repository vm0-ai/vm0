import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../../agents/route";
import { GET } from "../../agents/[id]/route";
import { PUT as putPermissionPolicies } from "../route";
import {
  createTestRequest,
  createTestCliToken,
  insertOrgMembersCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

let testCliToken: string;
let testOrgId: string;
let testUserId: string;

function postAgent(body: Record<string, unknown>, token: string) {
  return POST(
    createTestRequest("http://localhost:3000/api/zero/agents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

function getAgent(name: string, token: string) {
  return GET(
    createTestRequest(`http://localhost:3000/api/zero/agents/${name}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

function putPolicies(
  agentId: string,
  body: Record<string, unknown>,
  token: string,
) {
  return putPermissionPolicies(
    createTestRequest("http://localhost:3000/api/zero/permission-policies", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentId, ...body }),
    }),
  );
}

describe("PUT /api/zero/permission-policies", () => {
  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testUserId = user.userId;
    testOrgId = user.orgId;
    testCliToken = await createTestCliToken(user.userId);

    // Default test user is admin
    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: testUserId,
      role: "admin",
    });
  });

  it("should persist permission policies for an agent", async () => {
    const createRes = await postAgent({}, testCliToken);
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const policies = {
      slack: { "channels:read": "allow", "chat:write": "deny" },
    };

    const response = await putPolicies(
      created.agentId,
      { policies },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permissionPolicies).toStrictEqual(policies);
    expect(data.agentId).toBe(created.agentId);
  });

  it("should persist policies across reads", async () => {
    const created = await (await postAgent({}, testCliToken)).json();

    const policies = {
      slack: { "channels:read": "allow", "chat:write": "ask" },
    };

    await putPolicies(created.agentId, { policies }, testCliToken);

    // Read back via GET
    const getRes = await getAgent(created.agentId, testCliToken);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.permissionPolicies).toStrictEqual(policies);
  });

  it("should overwrite previous policies", async () => {
    const created = await (await postAgent({}, testCliToken)).json();

    const first = { slack: { "channels:read": "allow" } };
    await putPolicies(created.agentId, { policies: first }, testCliToken);

    const second = { slack: { "channels:read": "deny" } };
    const response = await putPolicies(
      created.agentId,
      { policies: second },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permissionPolicies).toStrictEqual(second);
  });

  it("should allow org admin to update another user's permission policies", async () => {
    const created = await (await postAgent({}, testCliToken)).json();

    // Create another admin user who is NOT the agent owner
    const otherAdmin = await context.setupUser({ prefix: "other-admin" });
    const otherAdminToken = await createTestCliToken(
      otherAdmin.userId,
      undefined,
      testOrgId,
    );

    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: otherAdmin.userId,
      role: "admin",
    });

    const policies = { slack: { "channels:read": "allow" } };
    const response = await putPolicies(
      created.agentId,
      { policies },
      otherAdminToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permissionPolicies).toStrictEqual(policies);
  });

  it("should return 403 for non-owner member", async () => {
    const created = await (await postAgent({}, testCliToken)).json();

    // Create another user who is a member (not admin, not owner)
    const otherMember = await context.setupUser({ prefix: "other-member" });
    const otherMemberToken = await createTestCliToken(
      otherMember.userId,
      undefined,
      testOrgId,
    );

    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: otherMember.userId,
      role: "member",
    });

    const response = await putPolicies(
      created.agentId,
      { policies: { slack: { "channels:read": "allow" } } },
      otherMemberToken,
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should allow agent owner with member role to update policies", async () => {
    // The default test user is admin AND the agent owner
    // Re-insert as member to prove ownership matters, not role
    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: testUserId,
      role: "member",
    });

    const created = await (await postAgent({}, testCliToken)).json();

    const policies = { slack: { "channels:read": "allow" } };
    const response = await putPolicies(
      created.agentId,
      { policies },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permissionPolicies).toStrictEqual(policies);
  });

  it("should return 400 for unknown connector ref", async () => {
    const created = await (await postAgent({}, testCliToken)).json();

    const response = await putPolicies(
      created.agentId,
      { policies: { "nonexistent-connector": { "perm:read": "allow" } } },
      testCliToken,
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(data.error.message).toContain("nonexistent-connector");
  });

  it("should return 400 for unknown permission name", async () => {
    const created = await (await postAgent({}, testCliToken)).json();

    const response = await putPolicies(
      created.agentId,
      { policies: { slack: { "totally-fake-permission": "allow" } } },
      testCliToken,
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("VALIDATION_ERROR");
    expect(data.error.message).toContain("totally-fake-permission");
  });

  it("should return 404 for nonexistent agent", async () => {
    const response = await putPolicies(
      "00000000-0000-0000-0000-000000000000",
      { policies: { slack: { "channels:read": "allow" } } },
      testCliToken,
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
    const created = await (await postAgent({}, testCliToken)).json();

    const response = await putPolicies(
      created.agentId,
      { policies: {} },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.permissionPolicies).toStrictEqual({});
  });

  it("should return permissionPolicies as null for new agents", async () => {
    const createRes = await postAgent({}, testCliToken);
    expect(createRes.status).toBe(201);
    const data = await createRes.json();
    expect(data.permissionPolicies).toBeNull();
  });

  it("should return full agent response shape", async () => {
    const created = await (await postAgent({}, testCliToken)).json();

    const policies = { slack: { "channels:read": "allow" } };
    const response = await putPolicies(
      created.agentId,
      { policies },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({
      agentId: created.agentId,
      description: expect.toBeOneOf([null, expect.any(String)]),
      displayName: expect.toBeOneOf([null, expect.any(String)]),
      sound: expect.toBeOneOf([null, expect.any(String)]),
      permissionPolicies: policies,
    });
  });

  it("should isolate policies between different agents", async () => {
    const agent1 = await (await postAgent({}, testCliToken)).json();
    const agent2 = await (await postAgent({}, testCliToken)).json();

    const policies1 = { slack: { "channels:read": "allow" } };
    const policies2 = { slack: { "channels:read": "deny" } };

    await putPolicies(agent1.agentId, { policies: policies1 }, testCliToken);
    await putPolicies(agent2.agentId, { policies: policies2 }, testCliToken);

    const get1 = await getAgent(agent1.agentId, testCliToken);
    const get2 = await getAgent(agent2.agentId, testCliToken);

    expect((await get1.json()).permissionPolicies).toStrictEqual(policies1);
    expect((await get2.json()).permissionPolicies).toStrictEqual(policies2);
  });
});
