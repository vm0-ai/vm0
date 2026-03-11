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
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import {
  createRun,
  executeQueuedRun,
  type CreateRunParams,
} from "../run-service";
import {
  enqueueRun,
  drainUserQueue,
  cleanupExpiredQueueEntries,
} from "../run-queue-service";

const context = testContext();

describe("run-queue-service", () => {
  let user: UserContext;
  let versionId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("agent"));
    versionId = compose.versionId;
  });

  function baseParams(overrides?: Partial<CreateRunParams>): CreateRunParams {
    return {
      userId: user.userId,
      agentComposeVersionId: versionId,
      prompt: "Queue test",
      ...overrides,
    };
  }

  describe("enqueueRun", () => {
    it("should create a queued run and queue entry", async () => {
      const result = await enqueueRun(baseParams({ prompt: "Queued run" }));

      expect(result.status).toBe("queued");
      expect(result.runId).toBeDefined();

      // Verify agent_runs record
      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe("queued");
      expect(run!.prompt).toBe("Queued run");

      // Verify queue entry exists
      const queueEntry = await findTestQueueEntry(result.runId);
      expect(queueEntry).toBeDefined();
      expect(queueEntry!.userId).toBe(user.userId);
      expect(queueEntry!.encryptedParams).toBeTruthy();
      expect(queueEntry!.expiresAt).toBeInstanceOf(Date);
    });

    it("should store encrypted params that can be decrypted", async () => {
      const secrets = { API_KEY: "sk-secret-123" };
      const result = await enqueueRun(
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

  describe("createRun with queue", () => {
    it("should enqueue second run when concurrency limit hit", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // First run succeeds normally
      const run1 = await createRun(baseParams({ prompt: "Run 1" }));
      expect(run1.status).toBe("pending");

      // Second run gets queued
      const run2 = await createRun(baseParams({ prompt: "Run 2" }));
      expect(run2.status).toBe("queued");

      // Third run also gets queued
      const run3 = await createRun(baseParams({ prompt: "Run 3" }));
      expect(run3.status).toBe("queued");
    });
  });

  describe("drainUserQueue", () => {
    it("should be a no-op when queue is empty", async () => {
      // Should not throw
      await drainUserQueue(user.userId, executeQueuedRun);
    });

    it("should dequeue and execute the oldest entry", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // Create a running run and a queued run
      await createRun(baseParams({ prompt: "Running" }));
      const queued = await createRun(baseParams({ prompt: "Queued" }));
      expect(queued.status).toBe("queued");

      // Simulate completion: mark running runs as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainUserQueue(user.userId, executeQueuedRun);

      // Queued run should now be dispatched (pending)
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");

      // Queue entry should be deleted
      const queueEntry = await findTestQueueEntry(queued.runId);
      expect(queueEntry).toBeUndefined();
    });
  });

  describe("cleanupExpiredQueueEntries", () => {
    it("should mark expired queue entries as timeout", async () => {
      // Drain any pre-existing expired entries from other test suites
      await cleanupExpiredQueueEntries();

      const result = await enqueueRun(baseParams({ prompt: "Will expire" }));

      // Manually set expiresAt to the past
      await expireQueueEntry(result.runId);

      const cleaned = await cleanupExpiredQueueEntries();
      expect(cleaned).toBe(1);

      // Run should be marked as timeout
      const run = await findTestRunRecord(result.runId);
      expect(run!.status).toBe("timeout");
      expect(run!.error).toContain("expired");

      // Queue entry should be deleted
      const queueEntry = await findTestQueueEntry(result.runId);
      expect(queueEntry).toBeUndefined();
    });

    it("should not affect non-expired entries", async () => {
      // Clean any pre-existing expired entries from other test suites
      await cleanupExpiredQueueEntries();

      await enqueueRun(baseParams({ prompt: "Not expired" }));

      const cleaned = await cleanupExpiredQueueEntries();
      expect(cleaned).toBe(0);
    });
  });
});
