import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  findTestRunRecord,
  findTestRunCallbacks,
  findTestQueueEntry,
  markRunningRunsAsCompleted,
  expireQueueEntry,
  setTestRunStatus,
  updateOrgTier,
  insertOrgMembersCacheEntry,
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import type { CreateRunParams } from "../../infra/run/run-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import {
  enqueueRun,
  drainOrgQueue,
  drainStaleQueues,
  cleanupExpiredQueueEntries,
  dispatchQueuedZeroRun,
} from "../zero-run-queue-service";
import {
  seedTestRun,
  insertTestQueueEntry,
} from "../../../__tests__/db-test-seeders/runs";
import { insertTestChatThread } from "../../../__tests__/db-test-seeders/agents";
import { getTestAgentSessionArtifacts } from "../../../__tests__/db-test-assertions/agents";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  AUTO_MEMORY_MOUNT_PATH,
  CODEX_AUTO_MEMORY_MOUNT_PATH,
} from "../memory";
import { mockAblyPublish } from "../../../__tests__/ably-mock";

const context = testContext();

describe("run-queue-service", () => {
  let user: UserContext;
  let composeId: string;
  let versionId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("agent"));
    composeId = compose.composeId;
    versionId = compose.versionId;
  });

  function baseParams(overrides?: Partial<CreateRunParams>): CreateRunParams {
    return {
      userId: user.userId,
      agentComposeVersionId: versionId,
      prompt: "Queue test",
      orgId: user.orgId,
      composeId,
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

    it("should seed agent_sessions.artifacts with memory on new session", async () => {
      const result = await enqueueRun(baseParams({ prompt: "Memory seed" }));

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();

      const artifacts = await getTestAgentSessionArtifacts(run!.sessionId);
      expect(artifacts).toEqual([
        {
          name: AUTO_MEMORY_ARTIFACT_NAME,
          mountPath: AUTO_MEMORY_MOUNT_PATH,
        },
      ]);
    });

    it("should seed codex queued sessions with codex memory path", async () => {
      const result = await enqueueRun(
        baseParams({ prompt: "Codex memory seed" }),
        { runtimeFramework: "codex" },
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();

      const artifacts = await getTestAgentSessionArtifacts(run!.sessionId);
      expect(artifacts).toEqual([
        {
          name: AUTO_MEMORY_ARTIFACT_NAME,
          mountPath: CODEX_AUTO_MEMORY_MOUNT_PATH,
        },
      ]);
    });
  });

  describe("drainOrgQueue", () => {
    it("should be a no-op when queue is empty", async () => {
      // Should not throw
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);
    });

    it("should publish queue:changed even when queue is empty", async () => {
      // Regression: a failed dispatch frees a concurrency slot; the queue view
      // must refresh even when there are no queued runs waiting. Ably only fires
      // when the org has members in cache, so we seed one entry here.
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: user.userId,
        role: "admin",
      });
      mockAblyPublish.mockClear();
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);
      expect(mockAblyPublish).toHaveBeenCalledWith("queue:changed", null);
    });

    it("should dequeue and execute the oldest entry", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run and a queued run
      await seedTestRun(user.userId, composeId, { prompt: "Running" });
      const queued = await enqueueRun(baseParams({ prompt: "Queued" }));
      expect(queued.status).toBe("queued");

      // Simulate completion: mark running runs as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue by orgId
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

      // Queued run should now be dispatched (pending)
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");

      // Queue entry should be deleted
      const queueEntry = await findTestQueueEntry(queued.runId);
      expect(queueEntry).toBeUndefined();
    });

    it("publishes chatThreadRunUpdated after dequeue so the chat UI can swap 'Waiting in queue' for the live thinking indicator", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Seed a thread and a queued run that is linked to it through
      // zero_runs.chat_thread_id (this is what publishChatThreadRunUpdated
      // looks up to route the signal). seedTestRun creates both agent_runs
      // and zero_runs in one shot; we then manually attach a queue entry
      // so drainOrgQueue can pick it up. An occupying "running" run keeps
      // the single concurrency slot busy until we free it.
      const threadId = await insertTestChatThread(
        user.userId,
        composeId,
        "queue test",
      );
      await seedTestRun(user.userId, composeId, { prompt: "Running" });
      const { runId: queuedRunId } = await seedTestRun(user.userId, composeId, {
        prompt: "Queued",
        status: "queued",
        chatThreadId: threadId,
      });
      await insertTestQueueEntry(queuedRunId);

      await markRunningRunsAsCompleted(user.userId);

      mockAblyPublish.mockClear();
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

      expect(mockAblyPublish).toHaveBeenCalledWith(
        `chatThreadRunUpdated:${threadId}`,
        null,
      );
    });

    it("should register callbacks for queued zero runs on dispatch", async () => {
      // Create a run directly (simulates what dequeueNextAtomic produces)
      const { runId } = await seedTestRun(user.userId, composeId, {
        prompt: "With callback",
      });

      const callbackUrl = "https://example.com/callback";
      const callbackPayload = { channelId: "C123", threadTs: "123.456" };
      const params = baseParams({
        prompt: "With callback",
        composeId,
        vars: { ZERO_AGENT_ID: composeId },
        callbacks: [
          {
            url: callbackUrl,
            secret: "test-secret",
            payload: callbackPayload,
          },
        ],
      });

      // No callbacks registered yet
      const callbacksBefore = await findTestRunCallbacks(runId);
      expect(callbacksBefore).toHaveLength(0);

      // dispatchQueuedZeroRun registers callbacks early, then fails later
      // during token generation / context building — that's expected in tests.
      await dispatchQueuedZeroRun(runId, params).catch(() => {});

      // Callbacks should be registered in the database despite later failure
      const callbacksAfter = await findTestRunCallbacks(runId);
      expect(callbacksAfter).toHaveLength(1);
      expect(callbacksAfter[0]!.url).toBe(callbackUrl);
      expect(callbacksAfter[0]!.payload).toEqual(callbackPayload);
    });

    it("should drain across users in the same org", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Alice creates a run → pending
      await seedTestRun(user.userId, composeId, { prompt: "Alice run" });

      // Bob is a different user in the same org
      const bob = await context.setupUser({ prefix: "test-bob" });

      // Bob's run gets queued (enqueue directly to bypass authorization)
      const bobRun = await enqueueRun(
        baseParams({
          userId: bob.userId,
          orgId: user.orgId,
          prompt: "Bob run",
        }),
      );
      expect(bobRun.status).toBe("queued");

      // Alice's run completes
      await markRunningRunsAsCompleted(user.userId);

      // Track which runs the dispatcher was called with
      const dispatchedRunIds: string[] = [];
      const mockDispatcher = async (runId: string) => {
        dispatchedRunIds.push(runId);
      };

      // Drain org queue — should dequeue Bob's run from Alice's org
      await drainOrgQueue(user.orgId, mockDispatcher);

      // Dispatcher should have been called with Bob's run
      expect(dispatchedRunIds).toContain(bobRun.runId);

      // Queue entry should be deleted
      const queueEntry = await findTestQueueEntry(bobRun.runId);
      expect(queueEntry).toBeUndefined();
    });

    it("should not dequeue when concurrency limit is reached", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run and a queued run
      await seedTestRun(user.userId, composeId, { prompt: "Running" });
      const queued = await enqueueRun(baseParams({ prompt: "Queued" }));
      expect(queued.status).toBe("queued");

      // Drain without completing the running run — concurrency limit blocks dequeue
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

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
      const run1 = await enqueueRun(baseParams({ prompt: "Run 1" }));
      const run2 = await enqueueRun(baseParams({ prompt: "Run 2" }));

      // Cancel the first run (simulates cancel handler race)
      await setTestRunStatus(run1.runId, "cancelled");

      // Track dispatched runs
      const dispatchedRunIds: string[] = [];
      const mockDispatcher = async (runId: string) => {
        dispatchedRunIds.push(runId);
      };

      // Drain should skip run1 (cancelled) and dispatch run2
      await drainOrgQueue(user.orgId, mockDispatcher);

      expect(dispatchedRunIds).toContain(run2.runId);
      expect(dispatchedRunIds).not.toContain(run1.runId);
    });

    it("should try next entry when dispatch fails", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
      reloadEnv();

      // Enqueue two runs
      const run1 = await enqueueRun(baseParams({ prompt: "Will fail" }));
      await enqueueRun(baseParams({ prompt: "Will succeed" }));

      // Dispatcher fails on first call, succeeds on second
      let callCount = 0;
      const mockDispatcher = async () => {
        callCount++;
        if (callCount === 1) throw new Error("Sandbox creation failed");
      };

      await drainOrgQueue(user.orgId, mockDispatcher);

      // First run should be marked failed
      const r1 = await findTestRunRecord(run1.runId);
      expect(r1!.status).toBe("failed");
      expect(r1!.error).toContain("Sandbox creation failed");

      // Second run should have been dispatched (status set to pending by dequeue)
      expect(callCount).toBe(2);
    });

    it("should use org tier from cache for concurrency limit", async () => {
      // Set env cap high so tier limit is the binding constraint
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "10");
      reloadEnv();

      // Update org table to "pro" tier (limit=2 vs free limit=1)
      await updateOrgTier(user.orgId, "pro");

      // Create 1 running run — fills free limit but not pro limit
      await seedTestRun(user.userId, composeId, { prompt: "Running" });
      const queued = await enqueueRun(baseParams({ prompt: "Queued" }));

      // With pro tier (limit=2), drain should succeed despite 1 active run
      const dispatchedRunIds: string[] = [];
      const mockDispatcher = async (runId: string) => {
        dispatchedRunIds.push(runId);
      };

      await drainOrgQueue(user.orgId, mockDispatcher);

      expect(dispatchedRunIds).toContain(queued.runId);

      // Queue entry should be consumed
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
      const result = await enqueueRun(baseParams({ prompt: "Not expired" }));

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

      const result = await enqueueRun(baseParams({ prompt: "Will expire" }));

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

      // user1 creates a run first (before changing Clerk mock)
      await seedTestRun(user.userId, composeId, {
        prompt: "User1 running",
      });

      // Create second user sharing user1's org
      const user2 = await context.setupUser({ prefix: "test-user-2" });

      // user2's run gets queued in the same org
      const run2 = await enqueueRun(
        baseParams({
          userId: user2.userId,
          orgId: user.orgId,
          prompt: "User2 queued",
        }),
      );
      expect(run2.status).toBe("queued");

      // drainStaleQueues should NOT drain user2's queue (org has an active run)
      await drainStaleQueues(dispatchQueuedZeroRun);

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

      // user1 creates a run first (before changing Clerk mock)
      await seedTestRun(user.userId, composeId, {
        prompt: "User1 running",
      });

      // Create second user sharing user1's org
      const user2 = await context.setupUser({ prefix: "test-user-2" });

      // user2's run gets queued in the same org
      const run2 = await enqueueRun(
        baseParams({
          userId: user2.userId,
          orgId: user.orgId,
          prompt: "User2 queued",
        }),
      );

      // Complete user1's run → org now has no active runs
      await markRunningRunsAsCompleted(user.userId);

      // drainStaleQueues should drain user2's queue
      const drained = await drainStaleQueues(dispatchQueuedZeroRun);
      expect(drained).toBeGreaterThanOrEqual(1);

      // Queue entry should be consumed
      const queueEntry = await findTestQueueEntry(run2.runId);
      expect(queueEntry).toBeUndefined();
    });
  });
});
