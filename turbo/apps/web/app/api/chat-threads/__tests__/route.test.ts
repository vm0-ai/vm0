import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("POST /api/chat-threads - Create Thread", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-thread"));
    testComposeId = composeId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Test thread",
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should create a chat thread", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "My thread",
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
  });

  it("should return 404 for non-existent compose", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: "00000000-0000-0000-0000-000000000000",
          title: "Test thread",
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(404);
  });
});

describe("GET /api/chat-threads - List Threads", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-thread"));
    testComposeId = composeId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/chat-threads?agentComposeId=${testComposeId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return empty array when no threads exist", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/chat-threads?agentComposeId=${testComposeId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toEqual([]);
  });

  it("should list created threads", async () => {
    // Create a thread first
    const createRequest = createTestRequest(
      "http://localhost:3000/api/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Listed thread",
        }),
      },
    );
    await POST(createRequest);

    // List threads
    const request = createTestRequest(
      `http://localhost:3000/api/chat-threads?agentComposeId=${testComposeId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].title).toBe("Listed thread");
    expect(data.threads[0].preview).toBe("Listed thread");
    expect(data.threads[0].id).toBeDefined();
    expect(data.threads[0].createdAt).toBeDefined();
    expect(data.threads[0].updatedAt).toBeDefined();
  });
});
