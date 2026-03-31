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
  deleteOrgRow,
  insertOrgDefaultModelProvider,
  insertOrgMembersEntry,
  createTestRunInDb,
  deleteOrgModelProviders,
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import type { CreateRunParams } from "../../run/run-service";
import { checkOrgCredits } from "../zero-preflight";
import { enqueueZeroRun, drainOrgQueue } from "../zero-queue-service";
import { isInsufficientCredits } from "../../errors";

const context = testContext();

describe("credit check", () => {
  let user: UserContext;
  let versionId: string;
  let composeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("agent"));
    versionId = compose.versionId;
    composeId = compose.composeId;
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

  describe("checkOrgCredits()", () => {
    it("should allow VM0 run when credits > 0", async () => {
      await setOrgCredits(user.orgId, 100);

      // Should not throw
      await checkOrgCredits(user.orgId, user.userId, "vm0");
    });

    it("should reject VM0 run when credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      await expect(
        checkOrgCredits(user.orgId, user.userId, "vm0"),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should reject VM0 run when credits are negative", async () => {
      await setOrgCredits(user.orgId, -500);

      await expect(
        checkOrgCredits(user.orgId, user.userId, "vm0"),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should allow non-VM0 run when credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      // Should not throw
      await checkOrgCredits(user.orgId, user.userId, "anthropic");
    });

    it("should reject when org default is VM0 and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      await expect(
        checkOrgCredits(user.orgId, user.userId, undefined),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should allow when org default is non-VM0 and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      // anthropic-api-key already set in beforeEach
      await checkOrgCredits(user.orgId, user.userId, undefined);
    });

    it("should allow when no org default provider and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      // Remove the default provider set in beforeEach
      await deleteOrgModelProviders(user.orgId);

      await checkOrgCredits(user.orgId, user.userId, undefined);
    });

    it("should allow when org_metadata row is missing", async () => {
      await deleteOrgRow(user.orgId);

      // Should not throw
      await checkOrgCredits(user.orgId, user.userId, "vm0");
    });
  });

  describe("member credit cap enforcement", () => {
    it("should reject VM0 run when creditEnabled is false", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      // Disable member via credit cap
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      await expect(
        checkOrgCredits(user.orgId, user.userId, "vm0"),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should allow non-VM0 run regardless of creditEnabled", async () => {
      await setOrgCredits(user.orgId, 10000);

      // Disable member via credit cap
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      // Should not throw
      await checkOrgCredits(user.orgId, user.userId, "anthropic");
    });

    it("should allow VM0 run when creditEnabled is true with cap set", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      // Set cap but leave enabled
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 10000,
        creditEnabled: true,
      });

      // Should not throw
      await checkOrgCredits(user.orgId, user.userId, "vm0");
    });

    it("should reject VM0 run when default provider is vm0 and creditEnabled is false", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      // Disable member via credit cap
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      // No explicit modelProvider — falls back to org default (vm0)
      await expect(
        checkOrgCredits(user.orgId, user.userId, undefined),
      ).rejects.toSatisfy(isInsufficientCredits);
    });
  });

  describe("dequeueNextAtomic() path", () => {
    beforeEach(async () => {
      // Drain tests need a model provider for createRun during dispatch
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
    });

    it("should fail queued VM0 run when credits depleted at drain time", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run + a queued VM0 run
      await createTestRunInDb(user.userId, composeId, {
        status: "running",
        prompt: "Running",
      });
      const queued = await enqueueZeroRun(
        baseParams({ prompt: "Queued VM0", modelProvider: "vm0" }),
      );

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed to free slot
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId);

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
      await createTestRunInDb(user.userId, composeId, {
        status: "running",
        prompt: "Running",
      });
      const queued = await enqueueZeroRun(
        baseParams({ prompt: "Queued Anthropic", modelProvider: "anthropic" }),
      );

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId);

      // Non-VM0 run should be dequeued normally
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");
    });

    it("should skip failed VM0 run and dequeue next non-VM0 run", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run
      await createTestRunInDb(user.userId, composeId, {
        status: "running",
        prompt: "Running",
      });

      // Enqueue two runs: first VM0, then non-VM0
      const vm0Run = await enqueueZeroRun(
        baseParams({ prompt: "VM0 run", modelProvider: "vm0" }),
      );
      const nonVm0Run = await enqueueZeroRun(
        baseParams({ prompt: "Anthropic run", modelProvider: "anthropic" }),
      );

      // Deplete credits
      await setOrgCredits(user.orgId, 0);

      // Mark running run as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId);

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
