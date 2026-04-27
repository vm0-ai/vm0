import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  updateOrgDefaultAgent,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  createTestZeroAgent,
  seedOrphanCompose,
  seedTestCompose,
} from "../../../../../../src/__tests__/db-test-seeders/agents";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { PUT as setDefaultAgent } from "../../../default-agent/route";
import { POST as completeOnboarding } from "../../complete/route";

const context = testContext();

describe("GET /api/zero/onboarding/status", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return needsOnboarding=true when user has no org", async () => {
    const userId = `no-org-user-${Date.now()}`;
    mockClerk({ userId, clerkOrgs: [], orgId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: true,
      isAdmin: false,
      hasOrg: false,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });

  it("should return hasOrg=true when org exists but no default agent", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasOrg).toBe(true);
    expect(data.hasDefaultAgent).toBe(false);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return needsOnboarding=false when default agent is configured and onboarding completed", async () => {
    await context.setupUser();

    // Create a compose and set as default via API
    const compose = await createTestCompose(uniqueId("onboarding-agent"));

    const setDefaultRequest = createTestRequest(
      "http://localhost:3000/api/zero/default-agent",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: compose.composeId }),
      },
    );
    const setDefaultResponse = await setDefaultAgent(setDefaultRequest);
    expect(setDefaultResponse.status).toBe(200);

    // Mark personal onboarding as done
    const completeRequest = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/complete",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      },
    );
    const completeResponse = await completeOnboarding(completeRequest);
    expect(completeResponse.status).toBe(200);

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: compose.composeId,
      defaultAgentMetadata: null,
    });
  });

  it("should return defaultAgentMetadata when compose has metadata", async () => {
    const user = await context.setupUser();

    // Create a compose; zero_agents metadata must match the compose agent name
    const agentName = uniqueId("onboarding-agent");
    const compose = await createTestCompose(agentName);

    // Seed zero_agents with metadata (metadata now lives in this table)
    await createTestZeroAgent(user.orgId, agentName, {
      displayName: "My Agent",
      sound: "friendly",
    });

    const setDefaultRequest = createTestRequest(
      "http://localhost:3000/api/zero/default-agent",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: compose.composeId }),
      },
    );
    const setDefaultResponse = await setDefaultAgent(setDefaultRequest);
    expect(setDefaultResponse.status).toBe(200);

    // Mark personal onboarding as done
    const completeRequest = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/complete",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      },
    );
    const completeResponse = await completeOnboarding(completeRequest);
    expect(completeResponse.status).toBe(200);

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: compose.composeId,
      defaultAgentMetadata: { displayName: "My Agent", sound: "friendly" },
    });
  });

  it("should return needsOnboarding=true for admin with default agent but onboarding not completed", async () => {
    await context.setupUser();

    // Create a compose and set as default via API (no model provider created)
    const compose = await createTestCompose(uniqueId("onboarding-agent"));

    const setDefaultRequest = createTestRequest(
      "http://localhost:3000/api/zero/default-agent",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: compose.composeId }),
      },
    );
    const setDefaultResponse = await setDefaultAgent(setDefaultRequest);
    expect(setDefaultResponse.status).toBe(200);

    // Without completing onboarding, needsOnboarding should still be true
    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasOrg).toBe(true);
    expect(data.hasDefaultAgent).toBe(true);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return needsOnboarding=true for non-admin member who has not completed onboarding", async () => {
    const user = await context.setupUser();

    // Switch to member role — the member path checks org_members_cache / Clerk metadata
    mockClerk({
      userId: user.userId,
      orgRole: "org:member",
      clerkOrgs: [
        {
          id: user.orgId,
          slug: `org-${user.userId}`,
          name: `org-${user.userId}`,
          role: "org:member",
        },
      ],
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.isAdmin).toBe(false);
    expect(data.hasOrg).toBe(true);
    expect(data.needsOnboarding).toBe(true);
  });

  it("should treat orphan compose (missing zero_agents row) as no default agent", async () => {
    const user = await context.setupUser();

    // Create a compose WITHOUT a zero_agents row — simulates a partially
    // completed onboarding where the agent_composes row was written but the
    // zero_agents insert never ran.
    const orphan = await seedOrphanCompose({
      userId: user.userId,
      name: `orphan-agent-${Date.now()}`,
      orgId: user.orgId,
    });

    // Directly set the orphan compose as defaultAgentId in org_metadata
    await updateOrgDefaultAgent(user.orgId, orphan.composeId);

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    // The orphan compose should NOT be reported as a valid default agent,
    // so the admin re-enters full onboarding and creates a complete agent.
    expect(data.hasDefaultAgent).toBe(false);
    expect(data.defaultAgentId).toBeNull();
    expect(data.needsOnboarding).toBe(true);
  });

  it("should ignore a default agent row from another org", async () => {
    const user = await context.setupUser();

    const otherCompose = await seedTestCompose({
      userId: user.userId,
      name: uniqueId("other-org-agent"),
      orgId: uniqueId("other-org"),
    });

    await updateOrgDefaultAgent(user.orgId, otherCompose.composeId);

    const request = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.hasDefaultAgent).toBe(false);
    expect(data.defaultAgentId).toBeNull();
    expect(data.needsOnboarding).toBe(true);
  });

  it("should return needsOnboarding=false for non-admin member after completing onboarding", async () => {
    const user = await context.setupUser();

    // Switch to member role
    mockClerk({
      userId: user.userId,
      orgRole: "org:member",
      clerkOrgs: [
        {
          id: user.orgId,
          slug: `org-${user.userId}`,
          name: `org-${user.userId}`,
          role: "org:member",
        },
      ],
    });

    // Complete onboarding via POST /api/zero/onboarding/complete
    const completeRequest = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/complete",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      },
    );
    const completeResponse = await completeOnboarding(completeRequest);
    expect(completeResponse.status).toBe(200);

    // Status should now show needsOnboarding=false
    const statusRequest = createTestRequest(
      "http://localhost:3000/api/zero/onboarding/status",
    );
    const statusResponse = await GET(statusRequest);
    const statusData = await statusResponse.json();

    expect(statusResponse.status).toBe(200);
    expect(statusData.isAdmin).toBe(false);
    expect(statusData.hasOrg).toBe(true);
    expect(statusData.needsOnboarding).toBe(false);
  });
});
