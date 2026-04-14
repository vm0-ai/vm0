import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  findTestRunRecord,
  findTestZeroRun,
  findTestRunCallbacks,
  findTestRunnerJobEntry,
  insertUserCacheEntry,
} from "../../../__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../__tests__/db-test-seeders/agents";
import { getTestZeroAgentId } from "../../../__tests__/db-test-assertions/agents";
import { createZeroRun, createZeroRunRecord } from "../zero-run-service";
import { verifyZeroToken } from "../../auth/sandbox-token";
import { decryptSecretsMap } from "../../shared/crypto/secrets-encryption";
import { reloadEnv } from "../../../env";
import { updateUserPreferences } from "../user/user-preferences-service";
import { updateUserFeatureSwitches } from "../user/feature-switches-service";
import { FeatureSwitchKey, type TriggerSource } from "@vm0/core";
import * as core from "@vm0/core";

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

  describe("createZeroRunRecord early metadata persistence", () => {
    it("should persist zero_runs row before dispatch so activity queries see correct triggerSource", async () => {
      const result = await createZeroRunRecord({
        userId: user.userId,
        prompt: "test prompt",
        agentId,
        triggerSource: "web",
      });

      // Before dispatchZeroRun is called, the zero_runs row must already exist
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

  describe("permission policies", () => {
    it("should carry all permissions and grant only allowed ones", async () => {
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
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const result = await createZeroRun(baseParams({ agentId: agentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Firewalls carry ALL permissions (unfiltered)
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
      expect(permNames).toContain("admin"); // ALL permissions present

      // networkPolicies only includes "allow" ones
      const granted = job!.executionContext.networkPolicies;
      expect(granted).toBeDefined();
      const slackGrant = granted!.slack;
      expect(slackGrant).toBeDefined();
      const grantedPerms = slackGrant!.allow;
      expect(grantedPerms).toContain("channels:read");
      expect(grantedPerms).toContain("channels:history");
      expect(grantedPerms).not.toContain("admin");
      // No unknownPermissionPolicies set → defaults to "allow"
      expect(slackGrant!.unknownPolicy).toBe("allow");
    });

    it("should grant all permissions when no explicit policies exist", async () => {
      const agentName = uniqueId("fw-nopol");
      await createTestCompose(agentName);
      await createTestConnector({ type: "slack" });
      await createTestZeroAgent(user.orgId, agentName, {});
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const result = await createZeroRun(baseParams({ agentId: agentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Firewalls carry all permissions
      const firewalls = job!.executionContext.firewalls;
      expect(firewalls).toBeDefined();
      const slackFw = firewalls!.find((fw) => {
        return fw.ref === "slack";
      });
      expect(slackFw).toBeDefined();

      // Slack has default policies — networkPolicies reflects default-allowed ones
      const granted = job!.executionContext.networkPolicies;
      expect(granted).toBeDefined();
      const grantedPerms = granted!.slack!.allow;
      expect(Array.isArray(grantedPerms)).toBe(true);
      expect(grantedPerms).toContain("channels:read");
      expect(grantedPerms).toContain("users:read");
      expect(grantedPerms).not.toContain("admin");
      expect(grantedPerms).not.toContain("chat:write");
    });

    it("should merge partial stored denies with default policies", async () => {
      const agentName = uniqueId("fw-allden");
      await createTestCompose(agentName);
      await createTestConnector({ type: "slack" });
      await createTestZeroAgent(user.orgId, agentName, {
        permissionPolicies: {
          slack: { "bookmarks:read": "deny", "bookmarks:write": "deny" },
        },
      });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const result = await createZeroRun(baseParams({ agentId: agentId }));

      const job = await findTestRunnerJobEntry(result.runId);
      expect(job).toBeDefined();
      // Firewalls still carry all permissions (unfiltered)
      const slackFw = job!.executionContext.firewalls?.find((fw) => {
        return fw.ref === "slack";
      });
      expect(slackFw).toBeDefined();
      expect(slackFw!.apis[0]!.permissions!.length).toBeGreaterThan(0);

      // Explicitly denied permissions are not granted
      const granted = job!.executionContext.networkPolicies;
      expect(granted).toBeDefined();
      expect(granted!.slack!.allow).not.toContain("bookmarks:read");
      expect(granted!.slack!.allow).not.toContain("bookmarks:write");
      // Default-allowed permissions (not overridden) are still granted
      expect(granted!.slack!.allow).toContain("channels:read");
      expect(granted!.slack!.allow).toContain("users:read");
      expect(granted!.slack!.unknownPolicy).toBe("allow");
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

  describe("AutoSkill guidance injection", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should inject skill guidance when AutoSkill feature switch is enabled", async () => {
      vi.spyOn(core, "isFeatureEnabled").mockImplementation(
        (key: FeatureSwitchKey) => {
          if (key === FeatureSwitchKey.AutoSkill) return true;
          return false;
        },
      );

      const result = await createZeroRun(baseParams());
      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("# Skill Management Guidance");
      expect(run!.appendSystemPrompt).toContain("zero skill create");
    });

    it("should not inject skill guidance when AutoSkill feature switch is disabled", async () => {
      const result = await createZeroRun(baseParams());
      const run = await findTestRunRecord(result.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).not.toContain(
        "# Skill Management Guidance",
      );
    });

    it("should pass user overrides to AutoSkill feature check", async () => {
      const spy = vi.spyOn(core, "isFeatureEnabled");

      await updateUserFeatureSwitches(user.orgId, user.userId, {
        [FeatureSwitchKey.AutoSkill]: false,
      });

      await createZeroRun(baseParams());

      expect(spy).toHaveBeenCalledWith(
        FeatureSwitchKey.AutoSkill,
        expect.objectContaining({
          overrides: expect.objectContaining({
            [FeatureSwitchKey.AutoSkill]: false,
          }),
        }),
      );
    });
  });
});
