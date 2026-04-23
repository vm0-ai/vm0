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
  findTestRunnerJobEntry,
  findTestZeroRun,
  findTestRunCallbacks,
  createTestSessionWithConversation,
} from "../../../__tests__/api-test-helpers";
import {
  clearComposeHeadVersion,
  createTestZeroAgent,
  deleteTestCompose,
} from "../../../__tests__/db-test-seeders/agents";
import { bindCustomSkillToAgent } from "../../../__tests__/db-test-seeders/skills";
import { createTestUserConnector } from "../../../__tests__/db-test-seeders/connectors";
import { getTestZeroAgentId } from "../../../__tests__/db-test-assertions/agents";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { createZeroRun } from "../zero-run-service";
import { reloadEnv } from "../../../env";
import type { TriggerSource } from "@vm0/core/contracts/logs";

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
      apiStartTime: Date.now(),
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

      await context.mocks.flushAfter();
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

  describe("custom skill volume injection", () => {
    it("should inject custom skills as additionalVolumes for new runs", async () => {
      const agentName = uniqueId("skill-agent");
      await createTestCompose(agentName);
      const skillAgentId = await getTestZeroAgentId(user.orgId, agentName);
      await bindCustomSkillToAgent(skillAgentId, "my-skill");
      await bindCustomSkillToAgent(skillAgentId, "data-tool");

      const result = await createZeroRun(baseParams({ agentId: skillAgentId }));

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.additionalVolumes).toEqual(
        expect.arrayContaining([
          {
            name: "custom-skill@my-skill",
            mountPath: "/home/user/.claude/skills/my-skill",
          },
          {
            name: "custom-skill@data-tool",
            mountPath: "/home/user/.claude/skills/data-tool",
          },
        ]),
      );
    });

    it("should inject only system skill volumes when agent has no custom skills", async () => {
      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.additionalVolumes).toBeDefined();
      expect(run!.additionalVolumes!.length).toBeGreaterThan(0);
      expect(
        run!.additionalVolumes!.every((v) => {
          return v.system === true;
        }),
      ).toBe(true);
    });

    it("should inject multiple custom skills after system skills preserving order", async () => {
      const agentName = uniqueId("multi-skill");
      await createTestCompose(agentName);
      const multiAgentId = await getTestZeroAgentId(user.orgId, agentName);
      await bindCustomSkillToAgent(multiAgentId, "alpha");
      await bindCustomSkillToAgent(multiAgentId, "beta");
      await bindCustomSkillToAgent(multiAgentId, "gamma");

      const result = await createZeroRun(baseParams({ agentId: multiAgentId }));

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      const volumes = run!.additionalVolumes!;
      // Custom skills appear at the end, after system skills
      const customVolumes = volumes.filter((v) => {
        return !v.system;
      });
      expect(customVolumes).toEqual([
        {
          name: "custom-skill@alpha",
          mountPath: "/home/user/.claude/skills/alpha",
        },
        {
          name: "custom-skill@beta",
          mountPath: "/home/user/.claude/skills/beta",
        },
        {
          name: "custom-skill@gamma",
          mountPath: "/home/user/.claude/skills/gamma",
        },
      ]);
    });

    it("should inject custom skill volumes on session resume", async () => {
      const agentName = uniqueId("resume-agent");
      const compose = await createTestCompose(agentName);
      const resumeAgentId = await getTestZeroAgentId(user.orgId, agentName);
      await bindCustomSkillToAgent(resumeAgentId, "my-skill");

      // Create session using the API-created compose version (which has
      // ANTHROPIC_API_KEY in its environment block, satisfying the model
      // provider check during session resume).
      const session = await createTestSessionWithConversation(
        user.userId,
        resumeAgentId,
        compose.versionId,
      );

      // Resume with sessionId — should inject custom skills (agent-level binding)
      const resumed = await createZeroRun({
        userId: user.userId,
        prompt: "continue",
        agentId: resumeAgentId,
        sessionId: session.id,
        triggerSource: "web",
        apiStartTime: Date.now(),
      });

      const resumedRun = await findTestRunRecord(resumed.runId);
      expect(resumedRun).toBeDefined();
      expect(resumedRun!.additionalVolumes).toEqual(
        expect.arrayContaining([
          {
            name: "custom-skill@my-skill",
            mountPath: "/home/user/.claude/skills/my-skill",
          },
        ]),
      );
      // System skills are also present
      expect(
        resumedRun!.additionalVolumes!.some((v) => {
          return v.system === true;
        }),
      ).toBe(true);
    });
  });

  describe("early metadata persistence", () => {
    it("should persist zero_runs row before dispatch so activity queries see correct triggerSource", async () => {
      // No flushAfter() — triggerSource must be visible from Phase 1.
      const result = await createZeroRun({
        userId: user.userId,
        prompt: "test prompt",
        agentId,
        triggerSource: "web",
        apiStartTime: Date.now(),
      });

      const zeroRun = await findTestZeroRun(result.runId);
      expect(zeroRun).toBeDefined();
      expect(zeroRun!.triggerSource).toBe("web");
    });

    it("should persist triggerSource for all sources before dispatch", async () => {
      const sources: TriggerSource[] = ["web", "slack", "schedule", "agent"];
      for (const triggerSource of sources) {
        const result = await createZeroRun({
          userId: user.userId,
          prompt: "test",
          agentId,
          triggerSource,
          apiStartTime: Date.now(),
        });

        const zeroRun = await findTestZeroRun(result.runId);
        expect(zeroRun).toBeDefined();
        expect(zeroRun!.triggerSource).toBe(triggerSource);
      }
    });
  });

  describe("connector skill volume scoping", () => {
    function getSystemSkillNames(
      volumes: Array<{ mountPath: string; system?: boolean }>,
    ) {
      return new Set(
        volumes
          .filter((v) => {
            return v.system === true;
          })
          .map((v) => {
            return v.mountPath.split("/").pop()!;
          }),
      );
    }

    it("mounts only SEED_SKILLS when no user_connectors rows exist", async () => {
      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      const skillNames = getSystemSkillNames(run!.additionalVolumes!);
      expect(skillNames.has("deep-dive")).toBe(true);
      expect(skillNames.has("slack")).toBe(false);
      expect(skillNames.has("github")).toBe(false);
    });

    it("mounts an authorized connector's skill alongside SEED_SKILLS", async () => {
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      const skillNames = getSystemSkillNames(run!.additionalVolumes!);
      expect(skillNames.has("deep-dive")).toBe(true);
      expect(skillNames.has("slack")).toBe(true);
      expect(skillNames.has("github")).toBe(false);
    });

    it("mounts multiple authorized connector skills", async () => {
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");
      await createTestUserConnector(user.orgId, user.userId, agentId, "github");

      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      const skillNames = getSystemSkillNames(run!.additionalVolumes!);
      expect(skillNames.has("slack")).toBe(true);
      expect(skillNames.has("github")).toBe(true);
    });
  });

  describe("deferred dispatch", () => {
    it("returns after Phase 1; Phase 2 runs only once the after() queue flushes", async () => {
      const result = await createZeroRun(baseParams());

      // Phase 1 is synchronous: run record exists immediately.
      const runBeforeFlush = await findTestRunRecord(result.runId);
      expect(runBeforeFlush).toBeDefined();

      // Phase 2 is queued via after(): no runner job yet.
      const jobBeforeFlush = await findTestRunnerJobEntry(result.runId);
      expect(jobBeforeFlush).toBeUndefined();

      await context.mocks.flushAfter();

      // After flushing, dispatch has run and the runner job is visible.
      const jobAfterFlush = await findTestRunnerJobEntry(result.runId);
      expect(jobAfterFlush).toBeDefined();
    });
  });

  describe("compose resolution error paths (Round 1 JOIN)", () => {
    it("throws notFound when composeId does not match any compose", async () => {
      const missingComposeId = "00000000-0000-0000-0000-000000000000";

      await expect(
        createZeroRun(baseParams({ agentId: missingComposeId })),
      ).rejects.toMatchObject({
        message: expect.stringContaining("Agent compose not found"),
      });
    });

    it("throws badRequest when compose has no head version", async () => {
      const agentName = uniqueId("headless-agent");
      const compose = await createTestCompose(agentName);
      const headlessAgentId = await getTestZeroAgentId(user.orgId, agentName);
      await clearComposeHeadVersion(compose.composeId);

      await expect(
        createZeroRun(baseParams({ agentId: headlessAgentId })),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "Agent compose has no versions. Run 'vm0 build' first.",
        ),
      });
    });

    it("throws notFound after compose row is deleted", async () => {
      const agentName = uniqueId("deleted-agent");
      const compose = await createTestCompose(agentName);
      const deletedAgentId = await getTestZeroAgentId(user.orgId, agentName);
      await deleteTestCompose(compose.composeId);

      await expect(
        createZeroRun(baseParams({ agentId: deletedAgentId })),
      ).rejects.toMatchObject({
        message: expect.stringContaining("Agent compose not found"),
      });
    });
  });
});
