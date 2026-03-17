import { describe, it, expect, beforeEach } from "vitest";
import { POST as addRunHandler } from "../route";
import { POST as createThreadHandler } from "../../../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("POST /api/chat-threads/:id/runs - Add Run to Thread", () => {
  let testComposeId: string;
  let threadId: string;

  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("chat-runs"));
    testComposeId = composeId;

    // Create a thread
    const createRequest = createTestRequest(
      "http://localhost:3000/api/chat-threads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: testComposeId,
          title: "Runs thread",
        }),
      },
    );
    const createResponse = await createThreadHandler(createRequest);
    const data = await createResponse.json();
    threadId = data.id;
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `http://localhost:3000/api/chat-threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: "some-run-id" }),
      },
    );
    const response = await addRunHandler(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should associate a run to a thread", async () => {
    const { runId } = await createTestRun(testComposeId, "Test prompt");

    const request = createTestRequest(
      `http://localhost:3000/api/chat-threads/${threadId}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const response = await addRunHandler(request);

    expect(response.status).toBe(204);
  });

  it("should return 404 for non-existent thread", async () => {
    const { runId } = await createTestRun(testComposeId, "Test prompt");

    const request = createTestRequest(
      "http://localhost:3000/api/chat-threads/00000000-0000-0000-0000-000000000000/runs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const response = await addRunHandler(request);

    expect(response.status).toBe(404);
  });

  it("should be idempotent when adding same run twice", async () => {
    const { runId } = await createTestRun(testComposeId, "Test prompt");

    const makeRequest = () =>
      createTestRequest(
        `http://localhost:3000/api/chat-threads/${threadId}/runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId }),
        },
      );

    const response1 = await addRunHandler(makeRequest());
    expect(response1.status).toBe(204);

    const response2 = await addRunHandler(makeRequest());
    expect(response2.status).toBe(204);
  });
});
