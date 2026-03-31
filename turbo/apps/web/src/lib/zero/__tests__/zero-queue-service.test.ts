import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  findTestRunRecord,
  findTestQueueEntry,
  markRunningRunsAsCompleted,
  expireQueueEntry,
  setTestRunStatus,
  updateOrgTier,
  createTestRunInDb,
  insertOrgDefaultModelProvider,
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import type { CreateRunParams } from "../../run/run-service";
import {
  enqueueZeroRun,
  drainOrgQueue,
  drainStaleQueues,
  cleanupExpiredQueueEntries,
} from "../zero-queue-service";

const context = testContext();

describe("zero-queue-service", () => {
  let user: UserContext;
  let versionId: string;
  let composeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("agent"));
    versionId = compose.versionId;
    composeId = compose.composeId;

    // Queue tests need a model provider configured (checkModelProviderConfigured
    // runs during drain → createRun → createRunRecord → buildAndDispatchRun)
    await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
  });

  function baseParams(overrides?: Partial<CreateRunParams>): CreateRunParams {
    return {
      userId: user.userId,
      agentComposeVersionId: versionId,
      prompt: "Queue test",
      orgId: user.orgId,
      ...overrides,
    };
  }

  describe("enqueueZeroRun", () => {
    it("should create a queued run and queue entry", async () => {
      const result = await enqueueZeroRun(baseParams({ prompt: "Queued run" }));

      expect(result.status).toBe("queued");
      expect(result.runId).toBeDefined();

      // Verify agent_runs record
      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe("queued");
      expect(run!.prompt).toBe("Queued run");

      // Verify queue entry exists with both userId and orgId
      const queueEntry = await findTestQueueEntry(result.runId);
      expect(queueEntry).toBeDefined();
      expect(queueEntry!.userId).toBe(user.userId);
      expect(queueEntry!.orgId).toBe(user.orgId);
      expect(queueEntry!.encryptedParams).toBeTruthy();
      expect(queueEntry!.expiresAt).toBeInstanceOf(Date);
    });

    it("should store encrypted params that can be decrypted", async () => {
      const secrets = { API_KEY: "sk-secret-123" };
      const result = await enqueueZeroRun(
        baseParams({ prompt: "With secrets", secrets }),
      );

      // Queue entry should have encrypted params
      const queueEntry = await findTestQueueEntry(result.runId);
      expect(queueEntry!.encryptedParams).toBeTruthy();

      // Run record should store secretNames but not actual secrets
      const run = await findTestRunRecord(result.runId);
      expect(run!.secretNames).toEqual(["API_KEY"]);
    });
  });

  describe("drainOrgQueue", () => {
    it("should be a no-op when queue is empty", async () => {
      // Should not throw
      await drainOrgQueue(user.orgId);
    });

    it("should dequeue and execute the oldest entry", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run directly (claims the slot)
      await createTestRunInDb(user.userId, composeId, {
        status: "running",
        prompt: "Running",
      });
      const queued = await enqueueZeroRun(baseParams({ prompt: "Queued" }));
      expect(queued.status).toBe("queued");

      // Simulate completion: mark running runs as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue by orgId
      await drainOrgQueue(user.orgId);

      // Queued run should now be dispatched (pending)
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");

      // Queue entry should be deleted
      const queueEntry = await findTestQueueEntry(queued.runId);
      expect(queueEntry).toBeUndefined();
    });

    it("should not dequeue when concurrency limit is reached", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run and a queued run
      await createTestRunInDb(user.userId, composeId, {
        status: "running",
        prompt: "Running",
      });
      const queued = await enqueueZeroRun(baseParams({ prompt: "Queued" }));
      expect(queued.status).toBe("queued");

      // Drain without completing the running run — concurrency limit blocks dequeue
      await drainOrgQueue(user.orgId);

      // Queue entry should still exist (nothing was dequeued)
      const queueEntry = await findTestQueueEntry(queued.runId);
      expect(queueEntry).toBeDefined();

      // Run should still be queued
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("queued");
    });

    it("should skip cancelled runs and try next entry", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
      reloadEnv();

      // Enqueue two runs
      const run1 = await enqueueZeroRun(baseParams({ prompt: "Run 1" }));
      const run2 = await enqueueZeroRun(baseParams({ prompt: "Run 2" }));

      // Cancel the first run (simulates cancel handler race)
      await setTestRunStatus(run1.runId, "cancelled");

      // Drain should skip run1 (cancelled) and dispatch run2
      await drainOrgQueue(user.orgId);

      // Run2 should be dispatched (pending)
      const r2 = await findTestRunRecord(run2.runId);
      expect(r2!.status).toBe("pending");
    });

    it("should use org tier from cache for concurrency limit", async () => {
      // Set env cap high so tier limit is the binding constraint
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "10");
      reloadEnv();

      // Update org table to "pro" tier (limit=2 vs free limit=1)
      await updateOrgTier(user.orgId, "pro");

      // Create 1 running run — fills free limit but not pro limit
      await createTestRunInDb(user.userId, composeId, {
        status: "running",
        prompt: "Running",
      });
      const queued = await enqueueZeroRun(baseParams({ prompt: "Queued" }));

      // With pro tier (limit=2), drain should succeed despite 1 active run
      await drainOrgQueue(user.orgId);

      // Queued run should be dequeued (pending)
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");

      // Queue entry should be consumed
      const queueEntry = await findTestQueueEntry(queued.runId);
      expect(queueEntry).toBeUndefined();
    });
  });

  describe("cleanupExpiredQueueEntries", () => {
    it("should mark expired queue entries as timeout", async () => {
      // Drain any pre-existing expired entries from other test suites
      await cleanupExpiredQueueEntries();

      const result = await enqueueZeroRun(
        baseParams({ prompt: "Will expire" }),
      );

      // Manually set expiresAt to the past
      await expireQueueEntry(result.runId);

      const cleaned = await cleanupExpiredQueueEntries();
      expect(cleaned).toBeGreaterThanOrEqual(1);

      // Run should be marked as timeout
      const run = await findTestRunRecord(result.runId);
      expect(run!.status).toBe("timeout");
      expect(run!.error).toContain("expired");

      // Queue entry should be deleted
      const queueEntry = await findTestQueueEntry(result.runId);
      expect(queueEntry).toBeUndefined();
    });

    it("should not affect non-expired entries", async () => {
      const result = await enqueueZeroRun(
        baseParams({ prompt: "Not expired" }),
      );

      await cleanupExpiredQueueEntries();

      // Non-expired entry should still exist in queue
      const queueEntry = await findTestQueueEntry(result.runId);
      expect(queueEntry).toBeDefined();

      // Run should still be queued
      const run = await findTestRunRecord(result.runId);
      expect(run!.status).toBe("queued");
    });

    it("should skip runs that are no longer queued", async () => {
      // Drain any pre-existing expired entries from other test suites
      await cleanupExpiredQueueEntries();

      const result = await enqueueZeroRun(
        baseParams({ prompt: "Will expire" }),
      );

      // Simulate a concurrent completion: mark the run as completed
      await setTestRunStatus(result.runId, "completed");

      // Expire the queue entry
      await expireQueueEntry(result.runId);

      // Cleanup should delete the queue entry but NOT overwrite completed status
      const cleaned = await cleanupExpiredQueueEntries();
      expect(cleaned).toBeGreaterThanOrEqual(1); // queue entry was deleted

      // Run should still be completed (not timeout)
      const run = await findTestRunRecord(result.runId);
      expect(run!.status).toBe("completed");
    });
  });

  describe("drainStaleQueues", () => {
    it("should not drain when another user in the same org has an active run", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // user1 creates a running run directly
      await createTestRunInDb(user.userId, composeId, {
        status: "running",
        prompt: "User1 running",
      });

      // Create second user sharing user1's org
      const user2 = await context.setupUser({ prefix: "test-user-2" });

      // user2's run gets queued in the same org
      const run2 = await enqueueZeroRun(
        baseParams({
          userId: user2.userId,
          orgId: user.orgId,
          prompt: "User2 queued",
        }),
      );
      expect(run2.status).toBe("queued");

      // drainStaleQueues should NOT drain user2's queue (org has an active run)
      await drainStaleQueues();

      // Queue entry should still exist — org-level concurrency prevented drain
      const queueEntry = await findTestQueueEntry(run2.runId);
      expect(queueEntry).toBeDefined();

      // Run should still be queued
      const run = await findTestRunRecord(run2.runId);
      expect(run!.status).toBe("queued");
    });

    it("should drain when org has no active runs", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // user1 creates a running run directly
      await createTestRunInDb(user.userId, composeId, {
        status: "running",
        prompt: "User1 running",
      });

      // Create second user sharing user1's org
      const user2 = await context.setupUser({ prefix: "test-user-2" });

      // user2's run gets queued in the same org
      const run2 = await enqueueZeroRun(
        baseParams({
          userId: user2.userId,
          orgId: user.orgId,
          prompt: "User2 queued",
        }),
      );

      // Complete user1's run → org now has no active runs
      await markRunningRunsAsCompleted(user.userId);

      // drainStaleQueues should drain user2's queue
      const drained = await drainStaleQueues();
      expect(drained).toBeGreaterThanOrEqual(1);

      // Queue entry should be consumed
      const queueEntry = await findTestQueueEntry(run2.runId);
      expect(queueEntry).toBeUndefined();
    });
  });
});
