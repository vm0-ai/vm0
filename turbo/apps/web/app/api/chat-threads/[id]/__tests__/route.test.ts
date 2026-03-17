import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { POST } from "../../route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/chat-threads/:id - Get Thread Detail", () => {
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-detail"));
    testComposeId = composeId;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/chat-threads/some-thread-id",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for non-existent thread", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/chat-threads/00000000-0000-0000-0000-000000000000",
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
  });

  it("should return thread detail with empty messages", async () => {
    // Create a thread
    const createRequest = createTestRequest(
      "http://localhost:3000/api/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Detail thread",
        }),
      },
    );
    const createResponse = await POST(createRequest);
    const { id: threadId } = await createResponse.json();

    // Get thread detail
    const request = createTestRequest(
      `http://localhost:3000/api/chat-threads/${threadId}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(threadId);
    expect(data.title).toBe("Detail thread");
    expect(data.agentComposeId).toBe(testComposeId);
    expect(data.chatMessages).toEqual([]);
    expect(data.latestSessionId).toBeNull();
    expect(data.unsavedRuns).toEqual([]);
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should not return thread owned by another user", async () => {
    // Create a thread as user 1
    const createRequest = createTestRequest(
      "http://localhost:3000/api/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Private thread",
        }),
      },
    );
    const createResponse = await POST(createRequest);
    const { id: threadId } = await createResponse.json();

    // Switch to user 2
    await context.setupUser({ prefix: "other-user" });

    // Try to get thread as user 2
    const request = createTestRequest(
      `http://localhost:3000/api/chat-threads/${threadId}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(404);
  });
});
