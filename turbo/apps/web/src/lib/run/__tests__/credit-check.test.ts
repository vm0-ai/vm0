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
  setOrgCredits,
  insertTestZeroRun,
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import { startRun, type CreateRunParams } from "../run-service";
import { drainOrgQueue, enqueueRun } from "../run-queue-service";
import { dispatchQueuedZeroRun } from "../../zero/zero-queue-service";

const context = testContext();

// NOTE: createRun() path and member credit cap enforcement tests have been
// moved to zero layer (zero/__tests__/credit-check.test.ts) because credit
// checks are now a zero layer concern in createZeroRun().

describe("credit check (infra queue path)", () => {
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
      prompt: "Credit check test",
      orgId: user.orgId,
      ...overrides,
    };
  }

  describe("dequeueNextAtomic() path", () => {
    it("should fail queued VM0 run when credits depleted at drain time", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run + a queued VM0 run
      await startRun({
        userId: user.userId,
        agentComposeVersionId: versionId,
        prompt: "Running",
        orgTier: "free",
      });
      const queued = await enqueueRun(
        baseParams({ prompt: "Queued VM0", modelProvider: "vm0" }),
      );
      await insertTestZeroRun(queued.runId, { modelProvider: "vm0" });

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed to free slot
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

      // Queued run should be marked as failed
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Insufficient credits");

      // Queue entry should be deleted
      const queueEntry = await findTestQueueEntry(queued.runId);
      expect(queueEntry).toBeUndefined();
    });

    it("should dequeue non-VM0 run when credits depleted", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run + a queued non-VM0 run
      await startRun({
        userId: user.userId,
        agentComposeVersionId: versionId,
        prompt: "Running",
        orgTier: "free",
      });
      const queued = await enqueueRun(
        baseParams({ prompt: "Queued Anthropic", modelProvider: "anthropic" }),
      );
      await insertTestZeroRun(queued.runId, { modelProvider: "anthropic" });

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

      // Non-VM0 run should be dequeued normally
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");
    });

    it("should skip failed VM0 run and dequeue next non-VM0 run", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run
      await startRun({
        userId: user.userId,
        agentComposeVersionId: versionId,
        prompt: "Running",
        orgTier: "free",
      });

      // Enqueue two runs: first VM0, then non-VM0
      const vm0Run = await enqueueRun(
        baseParams({ prompt: "VM0 run", modelProvider: "vm0" }),
      );
      await insertTestZeroRun(vm0Run.runId, { modelProvider: "vm0" });
      const nonVm0Run = await enqueueRun(
        baseParams({ prompt: "Anthropic run", modelProvider: "anthropic" }),
      );
      await insertTestZeroRun(nonVm0Run.runId, { modelProvider: "anthropic" });

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

      // VM0 run should be failed
      const vm0 = await findTestRunRecord(vm0Run.runId);
      expect(vm0!.status).toBe("failed");
      expect(vm0!.error).toContain("Insufficient credits");

      // Non-VM0 run should be dequeued
      const nonVm0 = await findTestRunRecord(nonVm0Run.runId);
      expect(nonVm0!.status).toBe("pending");
    });
  });
});
