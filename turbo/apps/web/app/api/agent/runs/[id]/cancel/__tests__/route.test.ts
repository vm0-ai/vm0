import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
  createTestCallback,
  findTestQueueEntry,
  findTestRunRecord,
  findTestRunCallbacks,
  setTestRunStatus,
  getOrgCacheEntry,
  insertTestQueueEntry,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";
import { reloadEnv } from "../../../../../../../src/env";
import { insertOrgMembersCacheEntry } from "../../../../../../../src/__tests__/db-test-seeders/org-members-cache";
import { mockAblyPublish } from "../../../../../../../src/__tests__/ably-mock";

const context = testContext();

describe("POST /api/agent/runs/:id/cancel - Cancel Run", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    mockAblyPublish.mockClear();
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
      // Create a queued run directly (queueing is a zero-layer concern,
      // so we set up the state manually instead of going through the CLI route)
      const { runId: queuedRunId } = await seedTestRun(
        user.userId,
        testComposeId,
        { status: "queued" },
      );
      await insertTestQueueEntry(queuedRunId);

      // Verify queue entry exists
      const queueBefore = await findTestQueueEntry(queuedRunId);
      expect(queueBefore).toBeDefined();

      // Cancel the queued run
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${queuedRunId}/cancel`,
        { method: "POST" },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("cancelled");

      // Queue entry should be removed (encrypted secrets deleted)
      const queueAfter = await findTestQueueEntry(queuedRunId);
      expect(queueAfter).toBeUndefined();
    });

    it("should drain queue after cancelling a running run", async () => {
      // Create a running run directly
      const running = await createTestRun(testComposeId, "Running run");
      expect(running.status).toBe("pending");

      // Create a queued run directly (queueing is a zero-layer concern)
      const { runId: queuedRunId } = await seedTestRun(
        user.userId,
        testComposeId,
        { status: "queued" },
      );
      await insertTestQueueEntry(queuedRunId);

      // Cancel the running run (frees the concurrency slot)
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${running.runId}/cancel`,
        { method: "POST" },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Flush the after() callback which triggers drainOrgQueue
      await context.mocks.flushAfter();

      // Queue drain was attempted — entry should be consumed
      // (The dispatched run won't reach "pending" because the test queue entry
      // has no encrypted params; actual dispatch is a zero-layer concern.)
      const queueEntry = await findTestQueueEntry(queuedRunId);
      expect(queueEntry).toBeUndefined();
    });
  });

  describe("Callback Dispatch on Cancel", () => {
    it("should dispatch registered callbacks after cancel", async () => {
      // Create a running run with a registered callback
      const run = await createTestRun(testComposeId, "Loop iteration");
      await createTestCallback({
        runId: run.runId,
        url: "http://localhost:3000/api/internal/callbacks/schedule/loop",
        payload: { scheduleId: "test-schedule", intervalSeconds: 60 },
      });

      // Verify callback is pending before cancel
      const beforeCallbacks = await findTestRunCallbacks(run.runId);
      expect(beforeCallbacks).toHaveLength(1);
      expect(beforeCallbacks[0]!.status).toBe("pending");

      // Cancel the run
      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
        { method: "POST" },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Flush the after() callback which triggers dispatchTerminalSideEffects
      await context.mocks.flushAfter();

      // Verify callback was dispatched (status changed from "pending")
      const afterCallbacks = await findTestRunCallbacks(run.runId);
      expect(afterCallbacks[0]!.status).not.toBe("pending");
    });
  });

  describe("Org-Scoped Filtering", () => {
    it("should return 404 for run from a different org", async () => {
      const otherOrg = await context.createAgentCompose(user.userId);
      const { runId } = await seedTestRun(user.userId, otherOrg.id, {
        status: "running",
        prompt: "Other org run",
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${runId}/cancel`,
        { method: "POST" },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should cancel run when switching to the correct org", async () => {
      const otherOrg = await context.createAgentCompose(user.userId);
      const { runId } = await seedTestRun(user.userId, otherOrg.id, {
        status: "running",
        prompt: "Other org run",
      });

      const orgEntry = await getOrgCacheEntry(otherOrg.orgId);
      mockClerk({
        userId: user.userId,
        orgId: otherOrg.orgId,
        orgSlug: orgEntry!.slug,
        clerkOrgs: [
          { id: otherOrg.orgId, slug: orgEntry!.slug, name: orgEntry!.slug },
        ],
      });

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${runId}/cancel`,
        { method: "POST" },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.id).toBe(runId);
      expect(data.status).toBe("cancelled");
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

  describe("Sandbox Token Capability Enforcement", () => {
    it("should accept sandbox token with agent-run:write", async () => {
      const run = await createTestRun(testComposeId, "Run to cancel");
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, run.runId);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it("should accept sandbox token with any capability", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-1");

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${randomUUID()}/cancel`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      const response = await POST(request);

      // Should pass auth (not 403) — returns 404 because sandbox token's runId doesn't exist
      expect(response.status).not.toBe(403);
    });
  });

  describe("Signal Publishing", () => {
    it("should publish thread and tasks signals after cancel", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-key:test-secret");
      reloadEnv();

      // Add user to org members cache so the tasks signal has someone to notify
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: user.userId,
      });

      const run = await createTestRun(testComposeId, "Run to cancel");

      const request = createTestRequest(
        `http://localhost:3000/api/agent/runs/${run.runId}/cancel`,
        { method: "POST" },
      );
      const response = await POST(request);
      expect(response.status).toBe(200);

      // Flush the after() callback to trigger signal publishing
      await context.mocks.flushAfter();

      expect(mockAblyPublish).toHaveBeenCalledWith(`thread:${run.runId}`, null);
      expect(mockAblyPublish).toHaveBeenCalledWith(`tasks:${user.orgId}`, null);
      expect(mockAblyPublish).toHaveBeenCalledWith(
        `runUpdated:${run.runId}`,
        null,
      );
    });
  });
});
