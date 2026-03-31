import { describe, it, expect, beforeEach } from "vitest";
import { POST as postAgent } from "../../agents/route";
import { POST, GET, PUT } from "../route";
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

function createAgent(token: string, orgSlug: string) {
  return postAgent(
    createTestRequest(`http://localhost:3000/api/zero/agents?org=${orgSlug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    }),
  );
}

function createAccessRequest(
  body: Record<string, unknown>,
  token: string,
  orgSlug: string,
) {
  return POST(
    createTestRequest(
      `http://localhost:3000/api/zero/firewall-access-requests?org=${orgSlug}`,
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

function listAccessRequests(
  agentId: string,
  token: string,
  orgSlug: string,
  status?: string,
) {
  const statusParam = status ? `&status=${status}` : "";
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/firewall-access-requests?org=${orgSlug}&agentId=${agentId}${statusParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function resolveAccessRequest(
  body: Record<string, unknown>,
  token: string,
  orgSlug: string,
) {
  return PUT(
    createTestRequest(
      `http://localhost:3000/api/zero/firewall-access-requests?org=${orgSlug}`,
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
  await clearSkillsData();
  await seedSeedSkills();
  const user = await context.setupUser();
  testUserId = user.userId;
  testOrgId = user.orgId;
  testCliToken = await createTestCliToken(user.userId);
  testOrgSlug = `org-${user.userId.slice(-8)}`;

  await insertOrgMembersCacheEntry({
    orgId: testOrgId,
    userId: testUserId,
    role: "admin",
  });
});

describe("POST /api/zero/firewall-access-requests", () => {
  it("should create a firewall access request", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    const response = await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
        reason: "Need to read issues",
      },
      testCliToken,
      testOrgSlug,
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
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    const first = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          reason: "First reason",
        },
        testCliToken,
        testOrgSlug,
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
        testOrgSlug,
      )
    ).json();

    // Should return same request ID with updated reason
    expect(second.id).toBe(first.id);
    expect(second.reason).toBe("Updated reason");
  });

  it("should return 400 for unknown firewall ref", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    const response = await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "nonexistent-firewall",
        permission: "read",
      },
      testCliToken,
      testOrgSlug,
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
      testOrgSlug,
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
      testOrgSlug,
    );

    expect(response.status).toBe(401);
  });

  it("should allow non-admin members to create requests", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    const member = await context.setupUser({ prefix: "member" });
    const memberToken = await createTestCliToken(member.userId);
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
      testOrgSlug,
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.requesterUserId).toBe(member.userId);
  });
});

describe("GET /api/zero/firewall-access-requests", () => {
  it("should list access requests for an agent", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
      testOrgSlug,
    );

    const response = await listAccessRequests(
      agent.agentId,
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].firewallRef).toBe("github");
  });

  it("should filter by status", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
      testOrgSlug,
    );

    // No approved requests yet
    const response = await listAccessRequests(
      agent.agentId,
      testCliToken,
      testOrgSlug,
      "approved",
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(0);
  });

  it("should return 400 when agentId is missing", async () => {
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/firewall-access-requests?org=${testOrgSlug}`,
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

  it("members should only see own requests", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    // Admin creates a request
    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
      testOrgSlug,
    );

    // Member creates a request
    const member = await context.setupUser({ prefix: "member" });
    const memberToken = await createTestCliToken(member.userId);
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
      testOrgSlug,
    );

    // Member should only see their own request
    const memberList = await listAccessRequests(
      agent.agentId,
      memberToken,
      testOrgSlug,
    );
    const memberData = await memberList.json();
    expect(memberData).toHaveLength(1);
    expect(memberData[0].firewallRef).toBe("slack");

    // Admin should see all requests
    const adminList = await listAccessRequests(
      agent.agentId,
      testCliToken,
      testOrgSlug,
    );
    const adminData = await adminList.json();
    expect(adminData).toHaveLength(2);
  });

  it("should include requesterName from Clerk user data", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

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
      testOrgSlug,
    );

    const response = await listAccessRequests(
      agent.agentId,
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].requesterName).toBe("Alice Smith");
  });

  it("should return null requesterName when Clerk has no name data", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    await createAccessRequest(
      {
        agentId: agent.agentId,
        firewallRef: "github",
        permission: "issues:read",
      },
      testCliToken,
      testOrgSlug,
    );

    const response = await listAccessRequests(
      agent.agentId,
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].requesterName).toBeNull();
  });
});

describe("PUT /api/zero/firewall-access-requests", () => {
  it("should approve a request and update firewall policies", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
          reason: "Need access",
        },
        testCliToken,
        testOrgSlug,
      )
    ).json();

    const response = await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      testCliToken,
      testOrgSlug,
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
        `http://localhost:3000/api/zero/agents/${agent.agentId}?org=${testOrgSlug}`,
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

  it("should reject a request without updating policies", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
        },
        testCliToken,
        testOrgSlug,
      )
    ).json();

    const response = await resolveAccessRequest(
      { requestId: created.id, action: "reject" },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("rejected");

    // Verify agent firewall policies were NOT updated
    const { GET: getAgentById } = await import("../../agents/[id]/route");
    const agentRes = await getAgentById(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}?org=${testOrgSlug}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${testCliToken}` },
        },
      ),
    );
    const agentData = await agentRes.json();
    expect(agentData.firewallPolicies).toBeNull();
  });

  it("should return 403 for non-admin users", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
        },
        testCliToken,
        testOrgSlug,
      )
    ).json();

    const member = await context.setupUser({ prefix: "member" });
    const memberToken = await createTestCliToken(member.userId);
    await insertOrgMembersCacheEntry({
      orgId: testOrgId,
      userId: member.userId,
      role: "member",
    });

    const response = await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      memberToken,
      testOrgSlug,
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
      testOrgSlug,
    );

    expect(response.status).toBe(404);
  });

  it("should return 400 for already resolved request", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    const created = await (
      await createAccessRequest(
        {
          agentId: agent.agentId,
          firewallRef: "github",
          permission: "issues:read",
        },
        testCliToken,
        testOrgSlug,
      )
    ).json();

    // Approve first
    await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      testCliToken,
      testOrgSlug,
    );

    // Try to reject the same request
    const response = await resolveAccessRequest(
      { requestId: created.id, action: "reject" },
      testCliToken,
      testOrgSlug,
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("ALREADY_RESOLVED");
  });

  it("should preserve existing firewall policies when approving", async () => {
    const agent = await (await createAgent(testCliToken, testOrgSlug)).json();

    // Set initial policies via firewall-policies endpoint
    const { PUT: putPolicies } = await import("../../firewall-policies/route");
    await putPolicies(
      createTestRequest(
        `http://localhost:3000/api/zero/firewall-policies?org=${testOrgSlug}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            agentId: agent.agentId,
            policies: { slack: { "channels:read": "allow" } },
          }),
        },
      ),
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
        testOrgSlug,
      )
    ).json();

    await resolveAccessRequest(
      { requestId: created.id, action: "approve" },
      testCliToken,
      testOrgSlug,
    );

    // Verify both policies exist
    const { GET: getAgentById } = await import("../../agents/[id]/route");
    const agentRes = await getAgentById(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agent.agentId}?org=${testOrgSlug}`,
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
