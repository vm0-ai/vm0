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
  insertOrgDefaultModelProvider,
  insertOrgMembersEntry,
  insertTestZeroRun,
} from "../../../__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../__tests__/db-test-assertions/agents";
import { reloadEnv } from "../../../env";
import type { CreateRunParams } from "../../infra/run/run-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import {
  drainOrgQueue,
  enqueueRun,
  dispatchQueuedZeroRun,
} from "../zero-run-queue-service";
import { seedTestRun } from "../../../__tests__/db-test-seeders/runs";

const context = testContext();

describe("credit check (infra queue path)", () => {
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

  function queueBaseParams(
    overrides?: Partial<CreateRunParams>,
  ): CreateRunParams {
    return {
      userId: user.userId,
      agentComposeVersionId: versionId,
      prompt: "Credit check test",
      orgId: user.orgId,
      composeId,
      ...overrides,
    };
  }

  describe("dequeueNextAtomic() path", () => {
    it("should fail queued VM0 run when credits depleted at drain time", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Create a running run + a queued VM0 run
      await seedTestRun(user.userId, composeId, { prompt: "Running" });
      const queued = await enqueueRun(
        queueBaseParams({ prompt: "Queued VM0", modelProvider: "vm0" }),
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
      await seedTestRun(user.userId, composeId, { prompt: "Running" });
      const queued = await enqueueRun(
        queueBaseParams({
          prompt: "Queued Anthropic",
          modelProvider: "anthropic",
        }),
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
      await seedTestRun(user.userId, composeId, { prompt: "Running" });

      // Enqueue two runs: first VM0, then non-VM0
      const vm0Run = await enqueueRun(
        queueBaseParams({ prompt: "VM0 run", modelProvider: "vm0" }),
      );
      await insertTestZeroRun(vm0Run.runId, { modelProvider: "vm0" });
      const nonVm0Run = await enqueueRun(
        queueBaseParams({
          prompt: "Anthropic run",
          modelProvider: "anthropic",
        }),
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

    it("should fail queued VM0 run when member creditEnabled is false at drain time", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      // Org has plenty of credits but member cap is exhausted
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      // Create a running run + a queued VM0 run
      await seedTestRun(user.userId, composeId, { prompt: "Running" });
      const queued = await enqueueRun(
        queueBaseParams({
          prompt: "Queued VM0 member cap",
          modelProvider: "vm0",
        }),
      );
      await insertTestZeroRun(queued.runId, { modelProvider: "vm0" });

      // Mark running run as completed to free slot
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

      // Queued run should be marked as failed due to member credit cap
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("Insufficient credits");
    });

    it("should dequeue non-VM0 run when member creditEnabled is false", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      reloadEnv();

      await setOrgCredits(user.orgId, 10000);
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      // Create a running run + a queued non-VM0 run
      await seedTestRun(user.userId, composeId, { prompt: "Running" });
      const queued = await enqueueRun(
        queueBaseParams({
          prompt: "Queued Anthropic member cap",
          modelProvider: "anthropic",
        }),
      );
      await insertTestZeroRun(queued.runId, { modelProvider: "anthropic" });

      // Mark running run as completed
      await markRunningRunsAsCompleted(user.userId);

      // Drain queue
      await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

      // Non-VM0 run should be dequeued despite member cap
      const run = await findTestRunRecord(queued.runId);
      expect(run!.status).toBe("pending");
    });
  });
});

describe("model provider check (queue dispatch path)", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  it("should fail queued zero run when no model provider configured at dispatch time", async () => {
    vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    reloadEnv();

    // Create compose WITHOUT default ANTHROPIC_API_KEY so model provider check applies
    const agentName = uniqueId("agent");
    const compose = await createTestCompose(agentName, {
      skipDefaultApiKey: true,
    });
    const agentId = await getTestZeroAgentId(user.orgId, agentName);

    // No org-level model provider configured — checkModelProviderConfigured will throw

    // Create a running run to force the next one into the queue
    await seedTestRun(user.userId, compose.composeId, {
      prompt: "Running",
    });

    // Enqueue a zero run (no explicit modelProvider)
    const queued = await enqueueRun({
      userId: user.userId,
      agentComposeVersionId: compose.versionId,
      prompt: "Queued no provider",
      orgId: user.orgId,
      composeId: compose.composeId,
      vars: { ZERO_AGENT_ID: agentId },
      agentName,
    });
    await insertTestZeroRun(queued.runId);

    // Mark running run as completed
    await markRunningRunsAsCompleted(user.userId);

    // Drain queue — dispatchQueuedZeroRun should fail with noModelProvider
    await drainOrgQueue(user.orgId, dispatchQueuedZeroRun);

    // Run should be marked as failed with model provider error
    const run = await findTestRunRecord(queued.runId);
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("No model provider configured");
  });
});
