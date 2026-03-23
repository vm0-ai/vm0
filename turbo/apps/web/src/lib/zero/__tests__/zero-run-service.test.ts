import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestSchedule,
  createTestZeroAgent,
  findTestRunRecord,
  findTestRunCallbacks,
  findTestRunnerJobEntry,
} from "../../../__tests__/api-test-helpers";
import { createZeroRun } from "../zero-run-service";
import { reloadEnv } from "../../../env";
import type { TriggerSource } from "@vm0/core";

const context = testContext();

describe("createZeroRun()", () => {
  let user: UserContext;
  let composeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("agent"));
    composeId = compose.composeId;
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  function baseParams(
    overrides?: Partial<Parameters<typeof createZeroRun>[0]>,
  ) {
    return {
      userId: user.userId,
      prompt: "Hello, world!",
      composeId,
      triggerSource: "web" as TriggerSource,
      ...overrides,
    };
  }

  describe("zero-layer defaults", () => {
    it("should inject memoryName into execution context", async () => {
      const result = await createZeroRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.memoryName).toBe("memory");
    });

    it("should inject artifact into storage manifest", async () => {
      const result = await createZeroRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.storageManifest).not.toBeNull();
      expect(job!.executionContext.storageManifest!.artifact).not.toBeNull();
    });

    it("should inject memory into storage manifest", async () => {
      const result = await createZeroRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.storageManifest).not.toBeNull();
      expect(job!.executionContext.storageManifest!.memory).not.toBeNull();
    });

    it("should inject agent identity into appendSystemPrompt", async () => {
      const agentName = uniqueId("identity-agent");
      const compose = await createTestCompose(agentName);
      await createTestZeroAgent(user.orgId, agentName, {
        displayName: "My Agent",
        description: "A helpful assistant",
        sound: "friendly",
      });

      const result = await createZeroRun(
        baseParams({ composeId: compose.composeId }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("My Agent");
      expect(run!.appendSystemPrompt).toContain("A helpful assistant");
    });

    it("should prepend identity before existing appendSystemPrompt", async () => {
      const agentName = uniqueId("prepend-agent");
      const compose = await createTestCompose(agentName);
      await createTestZeroAgent(user.orgId, agentName, {
        displayName: "Bot",
      });

      const result = await createZeroRun(
        baseParams({
          composeId: compose.composeId,
          appendSystemPrompt: "Custom instructions",
        }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toMatch(/Bot[\s\S]*Custom instructions/);
    });

    it("should not inject identity when no metadata exists", async () => {
      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toBeNull();
    });

    it("should inject disallowedTools with cron tools", async () => {
      const result = await createZeroRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.disallowedTools).toEqual(
        expect.arrayContaining(["CronCreate", "CronList", "CronDelete"]),
      );
    });
  });

  describe("trigger sources", () => {
    const triggerSources: TriggerSource[] = [
      "web",
      "schedule",
      "telegram",
      "slack",
      "email",
      "github",
    ];

    for (const triggerSource of triggerSources) {
      it(`should store triggerSource "${triggerSource}" on run record`, async () => {
        const result = await createZeroRun(baseParams({ triggerSource }));

        const run = await findTestRunRecord(result.runId);
        expect(run).toBeDefined();
        expect(run!.triggerSource).toBe(triggerSource);
      });
    }
  });

  describe("parameter forwarding", () => {
    it("should propagate scheduleId to run record", async () => {
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const result = await createZeroRun(
        baseParams({ scheduleId: schedule.id, triggerSource: "schedule" }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.scheduleId).toBe(schedule.id);
    });

    it("should propagate callbacks", async () => {
      const result = await createZeroRun(
        baseParams({
          callbacks: [
            {
              url: "https://example.com/callback",
              secret: "test-secret",
              payload: { scheduleId: "test-schedule", intervalSeconds: 300 },
            },
          ],
        }),
      );

      const callbacks = await findTestRunCallbacks(result.runId);
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]!.url).toBe("https://example.com/callback");
    });

    it("should leave continuedFromSessionId null when no sessionId given", async () => {
      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.continuedFromSessionId).toBeNull();
    });

    it("should propagate appendSystemPrompt", async () => {
      const result = await createZeroRun(
        baseParams({ appendSystemPrompt: "You are a helpful bot." }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      // appendSystemPrompt is prepended with agent identity, so check it contains our text
      expect(run!.appendSystemPrompt).toContain("You are a helpful bot.");
    });
  });
});
