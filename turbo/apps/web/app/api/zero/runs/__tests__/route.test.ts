import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestSessionWithConversation,
  createTestConnector,
  createTestUserConnector,
  findTestZeroRun,
  findTestRunRecord,
  findTestRunnerJobEntry,
  insertOrgDefaultModelProvider,
  insertUserCacheEntry,
  setOrgCredits,
  deleteOrgRow,
  insertOrgMembersEntry,
  findTestRunsByUserAndPrompt,
  createTestVolume,
} from "../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../src/__tests__/db-test-seeders/agents";
import { getTestZeroAgentId } from "../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  generateSandboxToken,
  generateZeroToken,
  verifyZeroToken,
} from "../../../../../src/lib/auth/sandbox-token";
import { decryptSecretsMap } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import { reloadEnv } from "../../../../../src/env";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";
// eslint-disable-next-line web/no-direct-db-in-tests -- Test setup: direct service call for data setup in runs route tests
import { updateUserPreferences } from "../../../../../src/lib/zero/user/user-preferences-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Test setup: direct service call for data setup in runs route tests
import { updateUserFeatureSwitches } from "../../../../../src/lib/zero/user/feature-switches-service";
import { FeatureSwitchKey, getCustomSkillStorageName } from "@vm0/core";
import * as core from "@vm0/core";
import { bindCustomSkillToAgent } from "../../../../../src/__tests__/db-test-seeders/skills";

const context = testContext();

const URL = "http://localhost:3000/api/zero/runs";

function postRun(body: Record<string, unknown>) {
  return POST(
    createTestRequest(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/zero/runs", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 403 for sandbox token without agent-run:write capability", async () => {
    mockClerk({ userId: null });
    const token = await generateSandboxToken("user-1", "run-1");

    const response = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentComposeId: "some-compose-id",
          prompt: "test prompt",
        }),
      }),
    );
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error.message).toContain("agent-run:write");
  });

  describe("sessionId inference", () => {
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const compose = await createTestCompose(uniqueId("session-agent"));
      agentId = await getTestZeroAgentId(user.orgId, compose.name);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

    it("should infer agentId from sessionId when agentId is not provided", async () => {
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
      const session = await createTestSessionWithConversation(
        user.userId,
        agentId,
      );

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session.id,
            prompt: "test delegation",
          }),
        }),
      );

      const data = await response.json();
      expect(response.status).toBe(201);
      expect(data.runId).toBeTruthy();
    });

    it("should return 403 when ZERO_TOKEN is used (agent-run:write excluded)", async () => {
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId: "00000000-0000-0000-0000-000000000000",
            prompt: "test prompt",
          }),
        }),
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent-run:write");
    });

    it("should return 400 when neither agentId nor sessionId is provided", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "test prompt",
          }),
        }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toBe("agentId is required");
    });
  });

  describe("triggerSource", () => {
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const compose = await createTestCompose(uniqueId("trigger-agent"));
      agentId = await getTestZeroAgentId(user.orgId, compose.name);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

    it("should return 403 for ZERO_TOKEN callers (agent-run:write excluded)", async () => {
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId,
            prompt: "delegated task",
          }),
        }),
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent-run:write");
    });

    it("should set triggerSource to 'web' for Clerk JWT callers", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "web task",
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      const zeroRun = await findTestZeroRun(data.runId);
      expect(zeroRun).toBeDefined();
      expect(zeroRun!.triggerSource).toBe("web");
    });

    it("should return 403 for ZERO_TOKEN callers even with parent run context", async () => {
      // Create a parent agent compose and a run for it (simulates the parent agent)
      // Must happen before mockClerk({ userId: null }) since createTestCompose needs auth
      const parentCompose = await createTestCompose(uniqueId("parent-agent"));
      const parentRun = await seedTestRun(
        user.userId,
        parentCompose.composeId,
        { status: "running" },
      );

      mockClerk({ userId: null });

      // Generate a ZERO_TOKEN as if from the parent run's sandbox
      const token = await generateZeroToken(
        user.userId,
        parentRun.runId,
        user.orgId,
      );

      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId,
            prompt: "delegated from parent",
          }),
        }),
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.message).toContain("agent-run:write");
    });

    it("should leave triggerAgentId null for web callers", async () => {
      const response = await POST(
        createTestRequest(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            prompt: "web task no parent",
          }),
        }),
      );

      expect(response.status).toBe(201);
      const data = await response.json();
      const zeroRun = await findTestZeroRun(data.runId);
      expect(zeroRun).toBeDefined();
      expect(zeroRun!.triggerAgentId).toBeNull();
    });
  });

  describe("zero-layer defaults", () => {
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const agentName = uniqueId("agent");
      await createTestCompose(agentName);
      agentId = await getTestZeroAgentId(user.orgId, agentName);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

    it("should inject memoryName into execution context", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.memoryName).toBe("memory");
    });

    it("should not inject artifact into storage manifest", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.storageManifest?.artifact).toBeNull();
    });

    it("should inject memory into storage manifest", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
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
      const identityAgentId = await getTestZeroAgentId(user.orgId, agentName);

      const response = await postRun({
        agentId: identityAgentId,
        prompt: "Hello",
      });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("My Agent");
      expect(run!.appendSystemPrompt).toContain("A helpful assistant");
    });

    it("should inject agent tools prompt even when no identity metadata exists", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("# Agent Tools");
      expect(run!.appendSystemPrompt).not.toContain("# Agent Identity");
    });

    it("should inject ZERO_TOKEN into execution context secrets", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      const encrypted = job!.executionContext.encryptedSecrets;
      expect(encrypted).not.toBeNull();

      const secrets = decryptSecretsMap(
        encrypted,
        globalThis.services.env.SECRETS_ENCRYPTION_KEY,
      );
      expect(secrets).not.toBeNull();
      expect(secrets!.ZERO_TOKEN).toBeDefined();

      const auth = verifyZeroToken(secrets!.ZERO_TOKEN!);
      expect(auth).not.toBeNull();
      expect(auth!.userId).toBe(user.userId);
      expect(auth!.runId).toBe(data.runId);
      expect(auth!.orgId).toBe(user.orgId);
      expect(auth!.capabilities).toEqual(
        expect.arrayContaining(["agent:read", "agent:write"]),
      );
    });

    it("should inject disallowedTools with cron tools", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      expect(job!.executionContext.disallowedTools).toEqual(
        expect.arrayContaining(["CronCreate", "CronList", "CronDelete"]),
      );
    });

    describe("custom skill volume injection", () => {
      it("should inject custom skill volume into storage manifest for new run", async () => {
        const skillName = uniqueId("test-skill");
        await bindCustomSkillToAgent(agentId, skillName);
        await createTestVolume(getCustomSkillStorageName(skillName));

        const response = await postRun({ agentId, prompt: "Hello" });
        expect(response.status).toBe(201);
        const data = await response.json();

        const job = await findTestRunnerJobEntry(data.runId);
        expect(job).toBeDefined();
        const storages = job!.executionContext.storageManifest!.storages;
        const expectedMountPath = `/home/user/.claude/skills/${skillName}`;
        const skillStorage = storages.find((s) => {
          return s.mountPath === expectedMountPath;
        });
        expect(skillStorage).toBeDefined();
      });

      it("should inject custom skill volume on session continue", async () => {
        const skillName = uniqueId("test-skill");
        const compose = await createTestCompose(uniqueId("skill-agent"));
        const skillAgentId = await getTestZeroAgentId(user.orgId, compose.name);
        await bindCustomSkillToAgent(skillAgentId, skillName);
        await createTestVolume(getCustomSkillStorageName(skillName));
        await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");

        const session = await createTestSessionWithConversation(
          user.userId,
          skillAgentId,
          compose.versionId,
          "claude-code",
        );

        const response = await postRun({
          agentId: skillAgentId,
          sessionId: session.id,
          prompt: "Continue session",
        });
        const data = await response.json();
        expect(response.status).toBe(201);

        const job = await findTestRunnerJobEntry(data.runId);
        expect(job).toBeDefined();
        const storages = job!.executionContext.storageManifest!.storages;
        const expectedMountPath = `/home/user/.claude/skills/${skillName}`;
        const skillStorage = storages.find((s) => {
          return s.mountPath === expectedMountPath;
        });
        expect(skillStorage).toBeDefined();
      });
    });

    describe("system skill volume injection", () => {
      it("should inject system skill volumes into additionalVolumes for new run", async () => {
        const response = await postRun({ agentId, prompt: "Hello" });
        expect(response.status).toBe(201);
        const data = await response.json();

        const run = await findTestRunRecord(data.runId);
        expect(run).toBeDefined();
        expect(run!.additionalVolumes).toBeDefined();

        // Verify a known SEED_SKILLS entry is present
        const deepDiveVolume = run!.additionalVolumes!.find((v) => {
          return v.name.includes("deep-dive");
        });
        expect(deepDiveVolume).toBeDefined();
        expect(deepDiveVolume!.mountPath).toBe(
          "/home/user/.claude/skills/deep-dive",
        );
        expect(deepDiveVolume!.system).toBe(true);

        // Verify storage name format
        expect(deepDiveVolume!.name).toMatch(/^agent-skills@/);
      });

      it("should inject system skill volumes on session continue", async () => {
        const compose = await createTestCompose(uniqueId("sys-skill-agent"));
        const sysSkillAgentId = await getTestZeroAgentId(
          user.orgId,
          compose.name,
        );
        await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");

        const session = await createTestSessionWithConversation(
          user.userId,
          sysSkillAgentId,
          compose.versionId,
          "claude-code",
        );

        const response = await postRun({
          agentId: sysSkillAgentId,
          sessionId: session.id,
          prompt: "Continue session",
        });
        const data = await response.json();
        expect(response.status).toBe(201);

        const run = await findTestRunRecord(data.runId);
        expect(run).toBeDefined();

        const deepDiveVolume = run!.additionalVolumes!.find((v) => {
          return v.name.includes("deep-dive");
        });
        expect(deepDiveVolume).toBeDefined();
        expect(deepDiveVolume!.system).toBe(true);
      });

      it("should place custom skills after system skills in additionalVolumes", async () => {
        const skillName = uniqueId("test-skill");
        await bindCustomSkillToAgent(agentId, skillName);

        const response = await postRun({ agentId, prompt: "Hello" });
        expect(response.status).toBe(201);
        const data = await response.json();

        const run = await findTestRunRecord(data.runId);
        expect(run).toBeDefined();

        const volumes = run!.additionalVolumes!;
        const systemIndex = volumes.findIndex((v) => {
          return v.system === true;
        });
        const customIndex = volumes.findIndex((v) => {
          return v.name === getCustomSkillStorageName(skillName);
        });

        expect(systemIndex).toBeGreaterThanOrEqual(0);
        expect(customIndex).toBeGreaterThan(systemIndex);
      });
    });
  });

  describe("parameter forwarding", () => {
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const agentName = uniqueId("fwd-agent");
      await createTestCompose(agentName);
      agentId = await getTestZeroAgentId(user.orgId, agentName);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

    it("should leave continuedFromSessionId null when no sessionId given", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.continuedFromSessionId).toBeNull();
    });
  });

  describe("user info injection", () => {
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const agentName = uniqueId("info-agent");
      await createTestCompose(agentName);
      agentId = await getTestZeroAgentId(user.orgId, agentName);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

    it("should inject # Current User Info with email and timezone into appendSystemPrompt", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("# Current User Info");
      expect(run!.appendSystemPrompt).toContain("Email:");
      expect(run!.appendSystemPrompt).toContain("Timezone:");
    });

    it("should default timezone to UTC when user has no timezone preference", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("Timezone: UTC");
    });

    it("should use user timezone preference when set", async () => {
      await updateUserPreferences(user.orgId, user.userId, {
        timezone: "Asia/Shanghai",
      });

      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("Timezone: Asia/Shanghai");
    });

    it("should include cached user name when available", async () => {
      await insertUserCacheEntry({
        userId: user.userId,
        email: "alice@example.com",
        name: "Alice Zhang",
      });

      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("Name: Alice Zhang");
    });

    it("should omit name from user info when not cached", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("# Current User Info");
      expect(run!.appendSystemPrompt).not.toContain("Name:");
    });
  });

  describe("permission policies", () => {
    let user: UserContext;

    beforeEach(async () => {
      user = await context.setupUser();
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

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

      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
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
      expect(permNames).toContain("admin");

      const granted = job!.executionContext.networkPolicies;
      expect(granted).toBeDefined();
      const slackGrant = granted!.slack;
      expect(slackGrant).toBeDefined();
      const grantedPerms = slackGrant!.allow;
      expect(grantedPerms).toContain("channels:read");
      expect(grantedPerms).toContain("channels:history");
      expect(grantedPerms).not.toContain("admin");
      expect(slackGrant!.unknownPolicy).toBe("allow");
    });

    it("should grant all permissions when no explicit policies exist", async () => {
      const agentName = uniqueId("fw-nopol");
      await createTestCompose(agentName);
      await createTestConnector({ type: "slack" });
      await createTestZeroAgent(user.orgId, agentName, {});
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      const firewalls = job!.executionContext.firewalls;
      expect(firewalls).toBeDefined();
      const slackFw = firewalls!.find((fw) => {
        return fw.ref === "slack";
      });
      expect(slackFw).toBeDefined();

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

      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      const slackFw = job!.executionContext.firewalls?.find((fw) => {
        return fw.ref === "slack";
      });
      expect(slackFw).toBeDefined();
      expect(slackFw!.apis[0]!.permissions!.length).toBeGreaterThan(0);

      const granted = job!.executionContext.networkPolicies;
      expect(granted).toBeDefined();
      expect(granted!.slack!.allow).not.toContain("bookmarks:read");
      expect(granted!.slack!.allow).not.toContain("bookmarks:write");
      expect(granted!.slack!.allow).toContain("channels:read");
      expect(granted!.slack!.allow).toContain("users:read");
      expect(granted!.slack!.unknownPolicy).toBe("allow");
    });

    it("should add multiple firewall entries for multi-ref connector", async () => {
      const agentName = uniqueId("fw-multi");
      await createTestCompose(agentName);
      await createTestConnector({ type: "github" });
      await createTestConnector({ type: "slack" });
      const agentId = await getTestZeroAgentId(user.orgId, agentName);
      await createTestUserConnector(user.orgId, user.userId, agentId, "github");
      await createTestUserConnector(user.orgId, user.userId, agentId, "slack");

      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const job = await findTestRunnerJobEntry(data.runId);
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
    let user: UserContext;
    let agentId: string;

    beforeEach(async () => {
      user = await context.setupUser();
      const agentName = uniqueId("skill-agent");
      await createTestCompose(agentName);
      agentId = await getTestZeroAgentId(user.orgId, agentName);
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
    });

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

      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.appendSystemPrompt).toContain("# Skill Management Guidance");
      expect(run!.appendSystemPrompt).toContain("zero skill create");
    });

    it("should not inject skill guidance when AutoSkill feature switch is disabled", async () => {
      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);
      const data = await response.json();

      const run = await findTestRunRecord(data.runId);
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

      const response = await postRun({ agentId, prompt: "Hello" });
      expect(response.status).toBe(201);

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

describe("POST /api/zero/runs — credit check", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("credit-agent"));
    agentId = await getTestZeroAgentId(user.orgId, compose.name);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  describe("createZeroRun path", () => {
    it("should allow VM0 run when credits > 0", async () => {
      await setOrgCredits(user.orgId, 100);

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
        modelProvider: "vm0",
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("pending");
      expect(data.runId).toBeDefined();
    });

    it("should reject VM0 run when credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
        modelProvider: "vm0",
      });

      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data.error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("should reject VM0 run when credits are negative", async () => {
      await setOrgCredits(user.orgId, -500);

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
        modelProvider: "vm0",
      });

      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data.error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("should allow non-VM0 run when credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
        modelProvider: "anthropic",
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("pending");
    });

    it("should reject when org default is VM0 and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
      });

      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data.error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("should allow when org default is non-VM0 and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("pending");
    });

    it("should allow when no org default provider and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("pending");
    });

    it("should reject when org_metadata row is missing", async () => {
      await deleteOrgRow(user.orgId);

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
        modelProvider: "vm0",
      });

      expect(response.status).toBe(404);
    });

    it("should not create run record for rejected VM0 run", async () => {
      await setOrgCredits(user.orgId, 0);

      const prompt = uniqueId("rejected-vm0-no-enqueue");
      const response = await postRun({
        agentId,
        prompt,
        modelProvider: "vm0",
      });

      expect(response.status).toBe(402);

      const runs = await findTestRunsByUserAndPrompt(user.userId, prompt);
      expect(runs).toHaveLength(0);
    });
  });

  describe("member credit cap enforcement", () => {
    it("should reject VM0 run when creditEnabled is false", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
        modelProvider: "vm0",
      });

      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data.error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("should allow non-VM0 run regardless of creditEnabled", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
        modelProvider: "anthropic",
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("pending");
    });

    it("should allow VM0 run when creditEnabled is true with cap set", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 10000,
        creditEnabled: true,
      });

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
        modelProvider: "vm0",
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.status).toBe("pending");
    });

    it("should reject VM0 run when default provider is vm0 and creditEnabled is false", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      const response = await postRun({
        agentId,
        prompt: "Credit check test",
      });

      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data.error.code).toBe("INSUFFICIENT_CREDITS");
    });
  });
});
