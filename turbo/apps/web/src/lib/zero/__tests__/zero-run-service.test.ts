import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestConnector,
  createTestUserConnector,
  createTestSchedule,
  createTestZeroAgent,
  getTestZeroAgentId,
  findTestRunRecord,
  findTestZeroRun,
  findTestRunCallbacks,
  findTestRunnerJobEntry,
  insertUserCacheEntry,
} from "../../../__tests__/api-test-helpers";
import { createZeroRun } from "../zero-run-service";
import { verifyZeroToken } from "../../auth/sandbox-token";
import { decryptSecretsMap } from "../../shared/crypto/secrets-encryption";
import { reloadEnv } from "../../../env";
import { updateUserPreferences } from "../user/user-preferences-service";
import type { TriggerSource } from "@vm0/core";

const context = testContext();

describe("createZeroRun()", () => {
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

  describe("zero-layer defaults", () => {
    it("should inject memoryName into execution context", async () => {
      const result = await createZeroRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.memoryName).toBe("memory");
    });

    it("should not inject artifact into storage manifest", async () => {
      const result = await createZeroRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.storageManifest?.artifact).toBeNull();
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
      await createTestCompose(agentName);
      await createTestZeroAgent(user.orgId, agentName, {
        displayName: "My Agent",
        description: "A helpful assistant",
        sound: "friendly",
      });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);

      const result = await createZeroRun(baseParams({ agentId: agentId }));

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("My Agent");
      expect(run!.appendSystemPrompt).toContain("A helpful assistant");
    });

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

    it("should inject agent tools prompt even when no identity metadata exists", async () => {
      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("# Agent Tools");
      expect(run!.appendSystemPrompt).not.toContain("# Agent Identity");
    });

    it("should inject ZERO_TOKEN into execution context secrets", async () => {
      const result = await createZeroRun(baseParams());

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      const encrypted = job!.executionContext.encryptedSecrets;
      expect(encrypted).not.toBeNull();

      // Decrypt and verify the ZERO_TOKEN
      const secrets = decryptSecretsMap(
        encrypted,
        globalThis.services.env.SECRETS_ENCRYPTION_KEY,
      );
      expect(secrets).not.toBeNull();
      expect(secrets!.ZERO_TOKEN).toBeDefined();

      // Verify the token is a valid zero token
      const auth = verifyZeroToken(secrets!.ZERO_TOKEN!);
      expect(auth).not.toBeNull();
      expect(auth!.userId).toBe(user.userId);
      expect(auth!.runId).toBe(result.runId);
      expect(auth!.orgId).toBe(user.orgId);
      expect(auth!.capabilities).toEqual(
        expect.arrayContaining(["agent:read", "agent:write"]),
      );
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

  describe("user info injection", () => {
    it("should inject # Current User Info with email and timezone into appendSystemPrompt", async () => {
      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("# Current User Info");
      expect(run!.appendSystemPrompt).toContain("Email:");
      expect(run!.appendSystemPrompt).toContain("Timezone:");
    });

    it("should default timezone to UTC when user has no timezone preference", async () => {
      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("Timezone: UTC");
    });

    it("should use user timezone preference when set", async () => {
      await updateUserPreferences(user.orgId, user.userId, {
        timezone: "Asia/Shanghai",
      });

      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("Timezone: Asia/Shanghai");
    });

    it("should include cached user name when available", async () => {
      await insertUserCacheEntry({
        userId: user.userId,
        email: "alice@example.com",
        name: "Alice Zhang",
      });

      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("Name: Alice Zhang");
    });

    it("should omit name from user info when not cached", async () => {
      const result = await createZeroRun(baseParams());

      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("# Current User Info");
      expect(run!.appendSystemPrompt).not.toContain("Name:");
    });

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

  describe("permission policies", () => {
    it("should add firewall with only allowed permissions", async () => {
      const agentName = uniqueId("fw-agent");
      await createTestCompose(agentName);
      await createTestConnector({ type: "slack" });
      await createTestZeroAgent(user.orgId, agentName, {
        permissionPolicies: {
          slack: {
            "channels:read": "allow",
            "channels:history": "allow",
            admin: "deny",
          },
        },
      });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      // Grant user permission to use slack connector for this agent
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const result = await createZeroRun(baseParams({ agentId: agentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      const firewalls = job!.executionContext.firewalls;
      expect(firewalls).toBeDefined();
      const slackFirewall = firewalls!.find((fw) => {
        return fw.ref === "slack";
      });
      expect(slackFirewall).toBeDefined();
      const permNames = slackFirewall!.apis[0]!.permissions!.map((p) => {
        return p.name;
      });
      expect(permNames).toContain("channels:read");
      expect(permNames).toContain("channels:history");
      expect(permNames).not.toContain("admin");
    });

    it("should apply default policies when no explicit policies exist", async () => {
      const agentName = uniqueId("fw-nopol");
      await createTestCompose(agentName);
      await createTestConnector({ type: "slack" });
      await createTestZeroAgent(user.orgId, agentName, {});
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      // Grant user permission to use slack connector for this agent
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const result = await createZeroRun(baseParams({ agentId: agentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      const firewalls = job!.executionContext.firewalls;
      expect(firewalls).toBeDefined();
      const slackFw = firewalls!.find((fw) => {
        return fw.ref === "slack";
      });
      expect(slackFw).toBeDefined();
      // Slack has default policies — only default-allowed permissions included
      const permNames = slackFw!.apis[0]!.permissions!.map((p) => {
        return p.name;
      });
      expect(permNames).toContain("channels:read");
      expect(permNames).toContain("users:read");
      expect(permNames).not.toContain("admin");
      expect(permNames).not.toContain("chat:write");
    });

    it("should keep firewall entry with empty permissions when all are denied", async () => {
      const agentName = uniqueId("fw-allden");
      await createTestCompose(agentName);
      await createTestConnector({ type: "slack" });
      await createTestZeroAgent(user.orgId, agentName, {
        permissionPolicies: {
          slack: { "bookmarks:read": "deny", "bookmarks:write": "deny" },
        },
      });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      // Grant user permission to use slack connector for this agent
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const result = await createZeroRun(baseParams({ agentId: agentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // All denied → entry preserved with empty permissions for token injection
      const slackFw = job!.executionContext.firewalls?.find((fw) => {
        return fw.ref === "slack";
      });
      expect(slackFw).toBeDefined();
      for (const api of slackFw!.apis) {
        expect(api.permissions).toEqual([]);
      }
    });

    it("should add multiple firewall entries for multi-ref connector", async () => {
      const agentName = uniqueId("fw-multi");
      await createTestCompose(agentName);
      // GitHub + Slack connectors → separate firewall entries
      await createTestConnector({ type: "github" });
      await createTestConnector({ type: "slack" });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      // Grant user permissions to use both connectors for this agent
      await createTestUserConnector(user.orgId, user.userId, agentId, "github");
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const result = await createZeroRun(baseParams({ agentId: agentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      const firewalls = job!.executionContext.firewalls;
      expect(firewalls).toBeDefined();
      const ghFw = firewalls!.find((fw) => {
        return fw.ref === "github";
      });
      const slackFw = firewalls!.find((fw) => {
        return fw.ref === "slack";
      });
      expect(ghFw).toBeDefined();
      expect(slackFw).toBeDefined();
    });
  });
});
