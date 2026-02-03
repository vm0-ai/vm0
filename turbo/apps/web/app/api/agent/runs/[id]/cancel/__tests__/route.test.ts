import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

const context = testContext();

describe("POST /api/agent/runs/:id/cancel - Cancel Run", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(
      `agent-${randomUUID().slice(0, 8)}`,
    );
    testComposeId = composeId;
  });

  describe("Successful Cancellation", () => {
    it("should cancel a running run", async () => {
      const run = await createTestRun(testComposeId, "Run to cancel");

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(run.runId);
      expect(data.status).toBe("cancelled");
      expect(data.message).toBe("Run cancelled successfully");
    });

    it("should kill E2B sandbox when cancelling", async () => {
      const run = await createTestRun(testComposeId, "Run with sandbox");

      context.mocks.e2b.sandbox.kill.mockClear();

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("cancelled");
      expect(context.mocks.e2b.sandbox.kill).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should return 401 for unauthenticated request", async () => {
      mockClerk({ userId: null });

      const run = await createTestRun(testComposeId, "Run to cancel");

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should return 404 for non-existent run", async () => {
      const fakeId = randomUUID();
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${fakeId}/cancel`,
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("No such run");
    });

    it("should return 404 for run belonging to another user", async () => {
      const otherUser = await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-agent-${Date.now()}`,
      );

      mockClerk({ userId: otherUser.userId });
      const otherRun = await createTestRun(otherComposeId, "Other user run");

      mockClerk({ userId: user.userId });
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${otherRun.runId}/cancel`,
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("No such run");
    });

    it("should return 400 when cancelling already completed run", async () => {
      const run = await createTestRun(testComposeId, "Run to complete");

      // Cancel it first
      await POST(
        createTestRequest(
          `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
          { method: "POST" },
        ),
      );

      // Try to cancel again
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("cannot be cancelled");
    });
  });
});
