import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

// Only mock external services

const context = testContext();

describe("GET /api/agent/composes/list", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toBe("Not authenticated");
  });

  it("should return no own composes when none exist in org", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.composes).toEqual([]);
  });

  it("should return all composes for the user's default org", async () => {
    // Create two test composes via API
    const agentName1 = `test-list-agent-1-${Date.now()}`;
    const agentName2 = `test-list-agent-2-${Date.now()}`;

    await createTestCompose(agentName1);
    await createTestCompose(agentName2);

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.composes).toHaveLength(2);

    // Check that both agents are in the list
    const names = data.composes.map((c: { name: string }) => {
      return c.name;
    });
    expect(names).toContain(agentName1);
    expect(names).toContain(agentName2);

    // Check structure of each compose
    for (const compose of data.composes) {
      expect(compose.name).toBeDefined();
      expect(compose.headVersionId).toBeDefined();
      expect(compose.updatedAt).toBeDefined();
      // headVersionId should be 64 hex chars
      expect(compose.headVersionId).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("should filter by org correctly - not show other user's composes", async () => {
    // Create compose for current user
    const userAgentName = `test-user-agent-${Date.now()}`;
    await createTestCompose(userAgentName);

    // Create another user and their compose
    const otherUser = await context.setupUser({ prefix: "other-user" });
    const otherAgentName = `test-other-agent-${Date.now()}`;
    await createTestCompose(otherAgentName);

    // Switch back to original user and list their composes
    mockClerk({ userId: user.userId });
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    // Should include user's compose
    const names = data.composes.map((c: { name: string }) => {
      return c.name;
    });
    expect(names).toContain(userAgentName);
    // Should not include other user's compose
    expect(names).not.toContain(otherAgentName);

    // Verify other user can see their own compose
    mockClerk({ userId: otherUser.userId });
    const otherRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const otherResponse = await GET(otherRequest);
    const otherData = await otherResponse.json();

    const otherNames = otherData.composes.map((c: { name: string }) => {
      return c.name;
    });
    expect(otherNames).toContain(otherAgentName);
    expect(otherNames).not.toContain(userAgentName);
  });

  it("should list composes by specified org slug", async () => {
    // Create a compose first
    const agentName = `test-org-agent-${Date.now()}`;
    await createTestCompose(agentName);

    // List by org slug
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const names = data.composes.map((c: { name: string }) => {
      return c.name;
    });
    expect(names).toContain(agentName);
  });
});
