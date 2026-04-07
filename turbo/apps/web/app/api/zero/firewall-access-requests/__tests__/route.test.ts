import { describe, it, expect, beforeEach } from "vitest";
import { POST as postAgent } from "../../agents/route";
import { POST, GET, PUT } from "../route";
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

function createAgent(token: string) {
  return postAgent(
    createTestRequest(`http://localhost:3000/api/zero/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    }),
  );
}

function createAccessRequest(body: Record<string, unknown>, token: string) {
  return POST(
    createTestRequest(
      `http://localhost:3000/api/zero/firewall-access-requests`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

function listAccessRequests(agentId: string, token: string, status?: string) {
  const statusParam = status ? `&status=${status}` : "";
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/firewall-access-requests?agentId=${agentId}${statusParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function resolveAccessRequest(body: Record<string, unknown>, token: string) {
  return PUT(
    createTestRequest(
      `http://localhost:3000/api/zero/firewall-access-requests`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

beforeEach(async () => {
  context.setupMocks();
  const user = await context.setupUser();
  testUserId = user.userId;
  testOrgId = user.orgId;
  testCliToken = await createTestCliToken(user.userId);

  await insertOrgMembersCacheEntry({
    orgId: testOrgId,
    userId: testUserId,
    role: "admin",
  });
});

describe("POST /api/zero/firewall-access-requests", () => {
  it("should create a firewall access request", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const response = await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
        reason: "Need to read issues",
      },
      testCliToken,
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.agentId).toBe(agent.agentId);
    expect(data.firewallRef).toBe("github");
    expect(data.permission).toBe("issues:read");
    expect(data.reason).toBe("Need to read issues");
    expect(data.status).toBe("pending");
    expect(data.requesterUserId).toBe(testUserId);
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
  });

  it("should dedup pending requests by updating reason", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const first = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          reason: "First reason",
        },
        testCliToken,
      )
    ).json();

    const second = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          reason: "Updated reason",
        },
        testCliToken,
      )
    ).json();

    // Should return same request ID with updated reason
    expect(second.id).toBe(first.id);
    expect(second.reason).toBe("Updated reason");
  });

  it("should create request with explicit action and return it in response", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const response = await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
        action: "deny",
        reason: "Should not read issues",
      },
      testCliToken,
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.action).toBe("deny");
    expect(data.permission).toBe("issues:read");
  });

  it("should treat different actions as separate requests for dedup", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const allow = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          action: "allow",
        },
        testCliToken,
      )
    ).json();

    const deny = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          action: "deny",
        },
        testCliToken,
      )
    ).json();

    expect(deny.id).not.toBe(allow.id);
    expect(allow.action).toBe("allow");
    expect(deny.action).toBe("deny");
  });

  it("should reuse rejected request and reset status to pending", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          reason: "First try",
        },
        testCliToken,
      )
    ).json();

    // Reject the request
    await resolveAccessRequest(
      { requestId: created.id, action: "reject" },
      testCliToken,
    );

    // Resend with updated reason
    const resent = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          reason: "Second try",
        },
        testCliToken,
      )
    ).json();

    expect(resent.id).toBe(created.id);
    expect(resent.status).toBe("pending");
    expect(resent.reason).toBe("Second try");
    expect(resent.resolvedBy).toBeNull();
    expect(resent.resolvedAt).toBeNull();
  });

  it("should return 400 for unknown firewall ref", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const response = await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "nonexistent-firewall",
        permission: "read",
      },
      testCliToken,
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.message).toContain("nonexistent-firewall");
  });

  it("should return 404 for nonexistent agent", async () => {
    const response = await createAccessRequest(
      {
        agentId: "00000000-0000-0000-0000-000000000000",
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
    );

    expect(response.status).toBe(404);
  });

  it("should return 401 without auth", async () => {
    mockClerk({ userId: null });

    const response = await createAccessRequest(
      {
        agentId: "00000000-0000-4000-8000-000000000001",
        firewallRef: "github",
        permission: "issues:read",
      },
      "no-token",
    );

    expect(response.status).toBe(401);
  });

  it("should allow non-admin members to create requests", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const member = await context.setupUser({ prefix: "member" });
    const memberToken = await createTestCliToken(
      member.userId,
      undefined,
      testOrgId,
    );
    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: member.userId,
      role: "member",
    });

    const response = await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      memberToken,
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.requesterUserId).toBe(member.userId);
  });
});

describe("GET /api/zero/firewall-access-requests", () => {
  it("should list access requests for an agent", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
    );

    const response = await listAccessRequests(agent.agentId, testCliToken);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].firewallRef).toBe("github");
  });

  it("should filter by status", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
    );

    // No approved requests yet
    const response = await listAccessRequests(
      agent.agentId,
      testCliToken,
      "approved",
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(0);
  });

  it("should fetch a single request by requestId", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          reason: "Need access",
        },
        testCliToken,
      )
    ).json();

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/firewall-access-requests?requestId=${created.id}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${testCliToken}` },
        },
      ),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(created.id);
    expect(data[0].permission).toBe("issues:read");
  });

  it("should return empty array for nonexistent requestId", async () => {
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/firewall-access-requests?requestId=00000000-0000-0000-0000-000000000000`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${testCliToken}` },
        },
      ),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(0);
  });

  it("should return 400 when agentId is missing", async () => {
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/firewall-access-requests`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${testCliToken}` },
        },
      ),
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.message).toContain("agentId");
  });

  it("non-owners should only see own requests, owner and admin see all", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    // Owner creates a request
    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
    );

    // Non-owner member creates a request
    const member = await context.setupUser({ prefix: "member" });
    const memberToken = await createTestCliToken(
      member.userId,
      undefined,
      testOrgId,
    );
    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: member.userId,
      role: "member",
    });

    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "slack",
        permission: "channels:read",
      },
      memberToken,
    );

    // Non-owner member should only see their own request
    const memberList = await listAccessRequests(agent.agentId, memberToken);
    const memberData = await memberList.json();
    expect(memberData).toHaveLength(1);
    expect(memberData[0].firewallRef).toBe("slack");

    // Agent owner should see all requests
    const ownerList = await listAccessRequests(agent.agentId, testCliToken);
    const ownerData = await ownerList.json();
    expect(ownerData).toHaveLength(2);

    // Org admin (non-owner) should also see all requests
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

    const adminList = await listAccessRequests(agent.agentId, otherAdminToken);
    const adminData = await adminList.json();
    expect(adminData).toHaveLength(2);
  });

  it("should include requesterName from Clerk user data", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    // Override Clerk mock to return user with a name
    mockClerk({
      userId: testUserId,
      firstName: "Alice",
      lastName: "Smith",
    });

    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
    );

    const response = await listAccessRequests(agent.agentId, testCliToken);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].requesterName).toBe("Alice Smith");
  });

  it("should return null requesterName when Clerk has no name data", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
    );

    const response = await listAccessRequests(agent.agentId, testCliToken);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].requesterName).toBeNull();
  });
});

describe("PUT /api/zero/firewall-access-requests", () => {
  it("should approve a request and update firewall policies", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          reason: "Need access",
        },
        testCliToken,
      )
    ).json();

    const response = await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("approved");
    expect(data.resolvedBy).toBe(testUserId);
    expect(data.resolvedAt).toBeDefined();

    // Verify agent firewall policies were updated
    const { GET: getAgentById } = await import("../../agents/[id]/route");
    const agentRes = await getAgentById(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${testCliToken}` },
        },
      ),
    );
    const agentData = await agentRes.json();
    expect(agentData.firewallPolicies).toStrictEqual({
      github: { "issues:read": "allow" },
    });
  });

  it("should approve a deny request and set policy to deny", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          action: "deny",
        },
        testCliToken,
      )
    ).json();

    const response = await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("approved");

    // Verify agent firewall policies were set to "deny"
    const { GET: getAgentById } = await import("../../agents/[id]/route");
    const agentRes = await getAgentById(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${testCliToken}` },
        },
      ),
    );
    const agentData = await agentRes.json();
    expect(agentData.firewallPolicies).toStrictEqual({
      github: { "issues:read": "deny" },
    });
  });

  it("should reject a request without updating policies", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
        },
        testCliToken,
      )
    ).json();

    const response = await resolveAccessRequest(
      { requestId: created.id, action: "reject" },
      testCliToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("rejected");

    // Verify agent firewall policies were NOT updated
    const { GET: getAgentById } = await import("../../agents/[id]/route");
    const agentRes = await getAgentById(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${testCliToken}` },
        },
      ),
    );
    const agentData = await agentRes.json();
    expect(agentData.firewallPolicies).toBeNull();
  });

  it("should allow org admin to resolve another user's agent requests", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
        },
        testCliToken,
      )
    ).json();

    // Create another admin who is NOT the agent owner
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

    const response = await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      otherAdminToken,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("approved");
    expect(data.resolvedBy).toBe(otherAdmin.userId);
  });

  it("should return 403 for non-owner member resolving requests", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
        },
        testCliToken,
      )
    ).json();

    // Create a non-admin member who is NOT the agent owner
    const member = await context.setupUser({ prefix: "member" });
    const memberToken = await createTestCliToken(
      member.userId,
      undefined,
      testOrgId,
    );
    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: member.userId,
      role: "member",
    });

    const response = await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      memberToken,
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should return 404 for nonexistent request", async () => {
    const response = await resolveAccessRequest(
      {
        requestId: "00000000-0000-0000-0000-000000000000",
        action: "approve",
      },
      testCliToken,
    );

    expect(response.status).toBe(404);
  });

  it("should return 400 for already resolved request", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
        },
        testCliToken,
      )
    ).json();

    // Approve first
    await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      testCliToken,
    );

    // Try to reject the same request
    const response = await resolveAccessRequest(
      { requestId: created.id, action: "reject" },
      testCliToken,
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("ALREADY_RESOLVED");
  });

  it("should preserve existing firewall policies when approving", async () => {
    const agent = await (await createAgent(testCliToken)).json();

    // Set initial policies via firewall-policies endpoint
    const { PUT: putPolicies } = await import("../../firewall-policies/route");
    await putPolicies(
      createTestRequest(`http://localhost:3000/api/zero/firewall-policies`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testCliToken}`,
        },
        body: JSON.stringify({
          agentId: agent.agentId,
          policies: { slack: { "channels:read": "allow" } },
        }),
      }),
    );

    // Create and approve a github request
    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
        },
        testCliToken,
      )
    ).json();

    await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      testCliToken,
    );

    // Verify both policies exist
    const { GET: getAgentById } = await import("../../agents/[id]/route");
    const agentRes = await getAgentById(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${testCliToken}` },
        },
      ),
    );
    const agentData = await agentRes.json();
    expect(agentData.firewallPolicies).toStrictEqual({
      slack: { "channels:read": "allow" },
      github: { "issues:read": "allow" },
    });
  });
});
