import { describe, it, expect, beforeEach, vi } from "vitest";
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
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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

  it("should return empty array when no composes exist", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.composes).toEqual([]);
  });

  it("should return all composes for the user scope", async () => {
    // Create two test composes via API
    const agentName1 = `test-list-agent-1-${Date.now()}`;
    const agentName2 = `test-list-agent-2-${Date.now()}`;

    await createTestCompose(agentName1);
    await createTestCompose(agentName2);

    // List composes
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.composes).toHaveLength(2);

    // Check that both agents are in the list
    const names = data.composes.map((c: { name: string }) => c.name);
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

  it("should filter by scope correctly - not show other user's composes", async () => {
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
    const names = data.composes.map((c: { name: string }) => c.name);
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

    const otherNames = otherData.composes.map((c: { name: string }) => c.name);
    expect(otherNames).toContain(otherAgentName);
    expect(otherNames).not.toContain(userAgentName);
  });

  it("should return 400 for non-existent scope", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes/list?scope=nonexistent-scope",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Scope not found");
  });

  it("should return 403 when user tries to access another user's scope", async () => {
    // Create another user with their own scope
    const otherUser = await context.setupUser({ prefix: "forbidden-user" });

    // Create a compose for the other user
    await createTestCompose(`forbidden-compose-${Date.now()}`);

    // Derive the other user's scope slug from their userId
    // userId format: {prefix}-{timestamp}-{uuid}
    // scope slug format: scope-{timestamp}-{uuid}
    const uniqueSuffix = otherUser.userId.replace("forbidden-user-", "");
    const otherScopeSlug = `scope-${uniqueSuffix}`;

    // Switch back to original user and try to access the other user's scope
    mockClerk({ userId: user.userId });
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/list?scope=${otherScopeSlug}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
    expect(data.error.message).toContain("don't have access");
  });

  it("should list composes by specified scope slug", async () => {
    // Create a compose first
    const agentName = `test-scope-agent-${Date.now()}`;
    await createTestCompose(agentName);

    // Derive the user's scope slug from their userId
    // userId format: test-user-{timestamp}-{uuid}
    // scope slug format: scope-{timestamp}-{uuid}
    const uniqueSuffix = user.userId.replace("test-user-", "");
    const scopeSlug = `scope-${uniqueSuffix}`;

    // List by scope slug
    const request = createTestRequest(
      `http://localhost:3000/api/agent/composes/list?scope=${scopeSlug}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const names = data.composes.map((c: { name: string }) => c.name);
    expect(names).toContain(agentName);
  });
});
