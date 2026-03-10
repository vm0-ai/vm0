import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  getTestScope,
  insertTestAgentPermission,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/agent/composes?name=<name>", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return compose when name exists", async () => {
    const agentName = `test-get-by-name-${Date.now()}`;

    // Create compose via API helper
    const { composeId } = await createTestCompose(agentName);

    // Get it by name
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
    expect(getData.content.agents[agentName]).toBeDefined();
    expect(getData.createdAt).toBeDefined();
    expect(getData.updatedAt).toBeDefined();
  });

  it("should return 404 when name does not exist", async () => {
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=nonexistent-agent",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");
    expect(getData.error.message).toContain("nonexistent-agent");
  });

  it("should return 400 when name query parameter is missing", async () => {
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    // Zod validation returns "expected string, received undefined" for missing required params
    expect(getData.error.message).toContain("expected string");
  });

  it("should only return compose for authenticated user", async () => {
    const agentName = `test-user-isolation-${Date.now()}`;

    // Create compose as current user
    await createTestCompose(agentName);

    // Create another user (setupUser also updates mockClerk to the new user)
    await context.setupUser({ prefix: "other-user" });

    // Try to get it as another user (mockClerk was updated by setupUser)
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");

    // Switch back to original user and verify they can access it
    mockClerk({ userId: user.userId });

    const verifyRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const verifyResponse = await GET(verifyRequest);
    expect(verifyResponse.status).toBe(200);
  });

  it("should handle URL-encoded names correctly", async () => {
    const agentName = `test-agent-with-hyphens-${Date.now()}`;

    // Create compose via API helper
    const { composeId } = await createTestCompose(agentName);

    // Get it with URL-encoded name
    const encodedName = encodeURIComponent(agentName);
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${encodedName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=any-agent",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(401);
    expect(getData.error.message).toContain("Not authenticated");
  });

  it("should return shared agent via cross-scope lookup with ?scope=", async () => {
    const agentName = `test-shared-agent-${Date.now()}`;

    // Create compose as owner
    const { composeId } = await createTestCompose(agentName);

    // Get the owner's scope slug
    const ownerScope = await getTestScope(user.scopeId);

    // Grant email permission to the recipient
    const recipientEmail = "recipient@example.com";
    await insertTestAgentPermission(composeId, recipientEmail, user.userId);

    // Switch to recipient user
    const recipient = await context.setupUser({ prefix: "recipient" });
    mockClerk({ userId: recipient.userId, email: recipientEmail });

    // Access the agent via cross-scope lookup
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}&scope=${ownerScope.slug}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
  });

  it("should return 404 for non-shared agent via cross-scope lookup", async () => {
    const agentName = `test-not-shared-${Date.now()}`;

    // Create compose as owner (no permission granted)
    await createTestCompose(agentName);

    // Get the owner's scope slug
    const ownerScope = await getTestScope(user.scopeId);

    // Switch to another user with no permission
    await context.setupUser({ prefix: "unauthorized" });

    // Try to access via cross-scope lookup
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}&scope=${ownerScope.slug}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");
  });

  it("should return own agent without ?scope= parameter", async () => {
    const agentName = `test-own-agent-${Date.now()}`;

    // Create compose as current user
    const { composeId } = await createTestCompose(agentName);

    // Access without scope param (uses resolveScope for own scope)
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
  });

  it("should return 404 for invalid scope slug in cross-scope lookup", async () => {
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=any-agent&scope=nonexistent-scope",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");
  });
});
