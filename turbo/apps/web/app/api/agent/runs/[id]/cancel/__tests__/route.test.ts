import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  findTestQueueEntry,
  findTestRunRecord,
  setTestRunStatus,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../../src/env";

const context = testContext();

describe("POST /api/agent/runs/:id/cancel - Cancel Run", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("agent"));
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
  });

  describe("Cancel Queued Run", () => {
    it("should cancel a queued run and remove queue entry", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // Create a running run (claims the slot)
      await createTestRun(testComposeId, "Running run");

      // Create a second run that gets queued
      const queued = await createTestRun(testComposeId, "Queued run");
      expect(queued.status).toBe("queued");

      // Verify queue entry exists
      const queueBefore = await findTestQueueEntry(queued.runId);
      expect(queueBefore).toBeDefined();

      // Cancel the queued run
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${queued.runId}/cancel`,
        { method: "POST" },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("cancelled");

      // Queue entry should be removed (encrypted secrets deleted)
      const queueAfter = await findTestQueueEntry(queued.runId);
      expect(queueAfter).toBeUndefined();
    });

    it("should drain queue after cancelling a running run", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // Create a running run (claims the slot)
      const running = await createTestRun(testComposeId, "Running run");
      expect(running.status).toBe("pending");

      // Create a second run that gets queued
      const queued = await createTestRun(testComposeId, "Queued run");
      expect(queued.status).toBe("queued");

      // Cancel the running run (frees the concurrency slot)
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${running.runId}/cancel`,
        { method: "POST" },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Flush the after() callback which triggers drainOrgQueue
      await context.mocks.flushAfter();

      // Queued run should now be dispatched (pending)
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");

      // Queue entry should be deleted
      const queueEntry = await findTestQueueEntry(queued.runId);
      expect(queueEntry).toBeUndefined();
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

    it("should not overwrite a concurrently completed run", async () => {
      const run = await createTestRun(testComposeId, "Run to cancel");

      // Simulate a concurrent completion between the SELECT and the transaction
      await setTestRunStatus(run.runId, "completed");

      // Cancel should fail — either fast-path or transaction guard catches it
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
        { method: "POST" },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);

      // Run should still be completed (not overwritten to cancelled)
      const record = await findTestRunRecord(run.runId);
      expect(record!.status).toBe("completed");
    });
  });
});
