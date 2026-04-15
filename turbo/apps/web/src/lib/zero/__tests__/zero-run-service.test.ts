import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestSchedule,
  findTestRunRecord,
  findTestZeroRun,
  findTestRunCallbacks,
} from "../../../__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../__tests__/db-test-seeders/agents";
import { getTestZeroAgentId } from "../../../__tests__/db-test-assertions/agents";
import { createZeroRun, createZeroRunRecord } from "../zero-run-service";
import { reloadEnv } from "../../../env";
import type { TriggerSource } from "@vm0/core";

// ---------------------------------------------------------------------------
// Tests for createZeroRun parameters NOT exposed by the POST /api/zero/runs
// route handler (appendSystemPrompt, scheduleId, callbacks, userInfoExtras,
// non-web trigger sources) and for the internal createZeroRunRecord function.
//
// Route-level tests live in app/api/zero/runs/__tests__/route.test.ts.
// ---------------------------------------------------------------------------

const context = testContext();

describe("createZeroRun() — service-only parameters", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const agentName = uniqueId("agent");
    await createTestCompose(agentName);
    agentId = await getTestZeroAgentId(user.orgId, agentName);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  function baseParams(
    overrides?: Partial<Parameters<typeof createZeroRun>[0]>,
  ) {
    return {
      userId: user.userId,
      prompt: "Hello, world!",
      agentId,
      triggerSource: "web" as TriggerSource,
      ...overrides,
    };
  }

  describe("appendSystemPrompt forwarding", () => {
    it("should prepend identity before existing appendSystemPrompt", async () => {
      const agentName = uniqueId("prepend-agent");
      await createTestCompose(agentName);
      await createTestZeroAgent(user.orgId, agentName, {
        displayName: "Bot",
      });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);

      const result = await createZeroRun(
        baseParams({
          agentId: agentId,
          appendSystemPrompt: "Custom instructions",
        }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toMatch(/Bot[\s\S]*Custom instructions/);
    });

    it("should propagate appendSystemPrompt", async () => {
      const result = await createZeroRun(
        baseParams({ appendSystemPrompt: "You are a helpful bot." }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("You are a helpful bot.");
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
      "agent",
    ];

    for (const triggerSource of triggerSources) {
      it(`should store triggerSource "${triggerSource}" on zero_runs record`, async () => {
        const result = await createZeroRun(baseParams({ triggerSource }));

        const zeroRun = await findTestZeroRun(result.runId);
        expect(zeroRun).toBeDefined();
        expect(zeroRun!.triggerSource).toBe(triggerSource);
      });
    }
  });

  describe("parameter forwarding", () => {
    it("should propagate scheduleId to run record", async () => {
      const agentName = uniqueId("sched-agent");
      const compose = await createTestCompose(agentName);
      await createTestZeroAgent(user.orgId, agentName, {});
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      const schedule = await createTestSchedule(
        compose.composeId,
        uniqueId("sched"),
      );
      const result = await createZeroRun(
        baseParams({
          agentId: agentId,
          scheduleId: schedule.id,
          triggerSource: "schedule",
        }),
      );

      const zeroRun = await findTestZeroRun(result.runId);
      expect(zeroRun).toBeDefined();
      expect(zeroRun!.scheduleId).toBe(schedule.id);
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
  });

  describe("user info injection — service-only parameters", () => {
    it("should merge userInfoExtras into user info block", async () => {
      const result = await createZeroRun(
        baseParams({
          userInfoExtras: {
            slackDisplayName: "alice.slack",
            slackUserId: "U12345",
          },
        }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain(
        "Slack display name: alice.slack",
      );
      expect(run!.appendSystemPrompt).toContain("Slack user ID: U12345");
    });

    it("should inject user info for all trigger sources", async () => {
      const triggerSources: TriggerSource[] = [
        "web",
        "schedule",
        "telegram",
        "slack",
        "email",
        "github",
        "agent",
      ];

      for (const triggerSource of triggerSources) {
        const result = await createZeroRun(baseParams({ triggerSource }));

        const run = await findTestRunRecord(result.runId);
        expect(run).toBeDefined();
        expect(run!.appendSystemPrompt).toContain("# Current User Info");
      }
    });

    it("should place user info between agent prompt and trigger context", async () => {
      const agentName = uniqueId("order-agent");
      await createTestCompose(agentName);
      await createTestZeroAgent(user.orgId, agentName, {
        displayName: "OrderBot",
        description: "An ordering assistant",
      });
      const orderId = await getTestZeroAgentId(user.orgId, agentName);

      const result = await createZeroRun(
        baseParams({
          agentId: orderId,
          appendSystemPrompt: "Custom trigger context",
        }),
      );

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      const prompt = run!.appendSystemPrompt!;
      const agentIdx = prompt.indexOf("# Agent Identity");
      const userInfoIdx = prompt.indexOf("# Current User Info");
      const triggerIdx = prompt.indexOf("Custom trigger context");
      expect(agentIdx).toBeLessThan(userInfoIdx);
      expect(userInfoIdx).toBeLessThan(triggerIdx);
    });
  });

  describe("createZeroRunRecord early metadata persistence", () => {
    it("should persist zero_runs row before dispatch so activity queries see correct triggerSource", async () => {
      const result = await createZeroRunRecord({
        userId: user.userId,
        prompt: "test prompt",
        agentId,
        triggerSource: "web",
      });

      const zeroRun = await findTestZeroRun(result.runId);
      expect(zeroRun).toBeDefined();
      expect(zeroRun!.triggerSource).toBe("web");
    });

    it("should persist triggerSource for all sources before dispatch", async () => {
      const sources: TriggerSource[] = ["web", "slack", "schedule", "agent"];
      for (const triggerSource of sources) {
        const result = await createZeroRunRecord({
          userId: user.userId,
          prompt: "test",
          agentId,
          triggerSource,
        });

        const zeroRun = await findTestZeroRun(result.runId);
        expect(zeroRun).toBeDefined();
        expect(zeroRun!.triggerSource).toBe(triggerSource);
      }
    });
  });
});
