import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  findTestRunRecord,
  findTestRunsByUserAndPrompt,
  findTestQueueEntry,
  markRunningRunsAsCompleted,
  setOrgCredits,
  deleteOrgRow,
  insertOrgDefaultModelProvider,
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import {
  createRun,
  dispatchQueuedRun,
  type CreateRunParams,
} from "../run-service";
import { drainOrgQueue, enqueueRun } from "../run-queue-service";
import { isInsufficientCredits } from "../../errors";

const context = testContext();

describe("credit check", () => {
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

  describe("createRun() path", () => {
    it("should allow VM0 run when credits > 0", async () => {
      await setOrgCredits(user.orgId, 100);

      const result = await createRun(baseParams({ modelProvider: "vm0" }));

      expect(result.status).toBe("pending");
      expect(result.runId).toBeDefined();
    });

    it("should reject VM0 run when credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      await expect(
        createRun(baseParams({ modelProvider: "vm0" })),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should reject VM0 run when credits are negative", async () => {
      await setOrgCredits(user.orgId, -500);

      await expect(
        createRun(baseParams({ modelProvider: "vm0" })),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should allow non-VM0 run when credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      const result = await createRun(
        baseParams({ modelProvider: "anthropic" }),
      );

      expect(result.status).toBe("pending");
    });

    it("should reject when org default is VM0 and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      await expect(createRun(baseParams())).rejects.toSatisfy(
        isInsufficientCredits,
      );
    });

    it("should allow when org default is non-VM0 and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");

      const result = await createRun(baseParams());

      expect(result.status).toBe("pending");
    });

    it("should allow when no org default provider and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      const result = await createRun(baseParams());

      expect(result.status).toBe("pending");
    });

    it("should allow when org_metadata row is missing", async () => {
      await deleteOrgRow(user.orgId);

      const result = await createRun(baseParams({ modelProvider: "vm0" }));

      expect(result.status).toBe("pending");
    });

    it("should not enqueue a rejected VM0 run", async () => {
      await setOrgCredits(user.orgId, 0);

      const prompt = "Rejected VM0 run - no enqueue";
      await expect(
        createRun(baseParams({ modelProvider: "vm0", prompt })),
      ).rejects.toSatisfy(isInsufficientCredits);

      // Verify no run record was created (credit check rejects before INSERT)
      const runs = await findTestRunsByUserAndPrompt(user.userId, prompt);
      expect(runs).toHaveLength(0);
    });
  });

  describe("dequeueNextAtomic() path", () => {
    it("should fail queued VM0 run when credits depleted at drain time", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run + a queued VM0 run
      await createRun(baseParams({ prompt: "Running" }));
      const queued = await enqueueRun(
        baseParams({ prompt: "Queued VM0", modelProvider: "vm0" }),
      );

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed to free slot
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId, dispatchQueuedRun);

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
      await createRun(baseParams({ prompt: "Running" }));
      const queued = await enqueueRun(
        baseParams({ prompt: "Queued Anthropic", modelProvider: "anthropic" }),
      );

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId, dispatchQueuedRun);

      // Non-VM0 run should be dequeued normally
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");
    });

    it("should skip failed VM0 run and dequeue next non-VM0 run", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run
      await createRun(baseParams({ prompt: "Running" }));

      // Enqueue two runs: first VM0, then non-VM0
      const vm0Run = await enqueueRun(
        baseParams({ prompt: "VM0 run", modelProvider: "vm0" }),
      );
      const nonVm0Run = await enqueueRun(
        baseParams({ prompt: "Anthropic run", modelProvider: "anthropic" }),
      );

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId, dispatchQueuedRun);

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
