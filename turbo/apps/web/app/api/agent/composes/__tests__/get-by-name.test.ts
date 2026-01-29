import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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
});
