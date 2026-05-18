import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET, POST } from "../route";
import { POST as createComposeRoute } from "../../composes/route";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestCompose,
  createTestCliToken,
  deleteTestCliToken,
  createTestOrgModelProvider,
  insertOrgModelPolicy,
  createTestConnector,
  createTestRun,
  getTestRun,
  completeTestRun,
  insertOrgCacheEntry,
  insertOrgMembersCacheEntry,
  getOrgCacheEntry,
  updateOrgTier,
  createTestVolume,
  createTestArtifact,
  findTestRunRecord,
  findTestRunnerJobEntry,
  findTestStorage,
  getTestAgentSessionWithConversation,
  createTestSecret,
} from "../../../../../src/__tests__/api-test-helpers";
import { POST as checkpointWebhook } from "../../../webhooks/agent/checkpoints/route";
import { GET as getSessionById } from "../../sessions/[id]/route";
import { POST as completeWebhook } from "../../../webhooks/agent/complete/route";
import { POST as pollRoute } from "../../../runners/poll/route";
import type { AgentComposeYaml } from "../../../../../src/lib/infra/agent-compose/types";
import { AUTO_MEMORY_MOUNT_PATH } from "../../../../../src/lib/zero/memory";
import { createTestZeroAgent } from "../../../../../src/__tests__/db-test-seeders/agents";
import { bindCustomSkillToAgent } from "../../../../../src/__tests__/db-test-seeders/skills";
import {
  generateSandboxToken,
  generateZeroToken,
} from "../../../../../src/lib/auth/sandbox-token";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  seedTestRun,
  seedStalePendingRun,
} from "../../../../../src/__tests__/db-test-seeders/runs";
import { insertTestUserVariable } from "../../../../../src/__tests__/db-test-seeders/secrets";
import { reloadEnv } from "../../../../../src/env";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
// eslint-disable-next-line web/no-direct-db-in-tests -- Route-level setup for feature-switch override state
import { updateUserFeatureSwitches } from "../../../../../src/lib/zero/user/feature-switches-service";

const context = testContext();

async function createAnthropicModelPolicy(orgId: string): Promise<void> {
  const provider = await createTestOrgModelProvider(
    "anthropic-api-key",
    "test-api-key",
  );
  await insertOrgModelPolicy({
    orgId,
    model: "claude-sonnet-4-6",
    isDefault: true,
    defaultProviderType: "anthropic-api-key",
    credentialScope: "org",
    modelProviderId: provider.id,
  });
}

describe("POST /api/agent/runs - Internal Runs API", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    // Create test compose with unique name to avoid conflicts between parallel tests
    const { composeId } = await createTestCompose(uniqueId("agent"));
    testComposeId = composeId;
  });

  describe("Fire-and-Forget Execution", () => {
    it("should return immediately with pending status", async () => {
      const startTime = Date.now();
      const data = await createTestRun(testComposeId, "Test prompt");
      const responseTime = Date.now() - startTime;

      // Should return quickly (run prep only, not agent execution)
      expect(responseTime).toBeLessThan(5000);
      expect(data.runId).toBeDefined();
      expect(data.status).toBe("pending");
    });

    it("should create run with pending status", async () => {
      const data = await createTestRun(testComposeId, "Test run creation");

      // Verify via API
      const run = await getTestRun(data.runId);

      expect(run.status).toBe("pending");
      expect(run.completedAt).toBeNull();
    });

    it("should accept memory as an artifact at the auto-memory mount path", async () => {
      const memoryArtifact = uniqueId("my-memory");
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Test with memory",
            artifacts: [
              { name: memoryArtifact, mountPath: AUTO_MEMORY_MOUNT_PATH },
            ],
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.runId).toBeDefined();
      expect(data.status).toBe("pending");
    });

    it("should reject legacy artifactName body field with 400", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Legacy artifactName should be rejected",
            artifactName: "legacy-artifact",
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("should not inject agent identity (CLI path)", async () => {
      const agentName = uniqueId("identity-agent");
      const { composeId } = await createTestCompose(agentName);
      await createTestZeroAgent(user.orgId, agentName, {
        displayName: "My Agent",
        description: "A helpful assistant",
        sound: "friendly",
      });

      const data = await createTestRun(composeId, "Hello");
      const run = await getTestRun(data.runId);

      // CLI path does not inject agent identity — that's done by createZeroRun
      expect(run.appendSystemPrompt).toBeNull();
    });

    it("should pass through appendSystemPrompt unchanged", async () => {
      const data = await createTestRun(testComposeId, "Hello", {
        appendSystemPrompt: "Custom instructions",
      });
      const run = await getTestRun(data.runId);

      expect(run.appendSystemPrompt).toBe("Custom instructions");
    });

    it("should propagate appendSystemPrompt through runner job dispatch", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const data = await createTestRun(testComposeId, "Hello", {
        appendSystemPrompt: "Your name is Aria.",
      });

      const run = await findTestRunRecord(data.runId);
      expect(run!.appendSystemPrompt).toBe("Your name is Aria.");

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
    });

    it("should propagate user feature switch overrides through runner job dispatch", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();
      await updateUserFeatureSwitches(user.orgId, user.userId, {
        [FeatureSwitchKey.ComputerUse]: true,
      });

      const data = await createTestRun(testComposeId, "Hello");

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      expect(
        job!.executionContext.featureFlags?.[FeatureSwitchKey.ComputerUse],
      ).toBe(true);
    });

    it("should always set lastHeartbeatAt", async () => {
      const data = await createTestRun(testComposeId, "Hello");

      const run = await findTestRunRecord(data.runId);

      expect(run!.lastHeartbeatAt).not.toBeNull();
    });

    it("should refresh lastHeartbeatAt during pipeline", async () => {
      const data = await createTestRun(testComposeId, "Hello");

      const run = await findTestRunRecord(data.runId);

      // The mid-pipeline heartbeat UPDATE runs after generateSandboxToken +
      // buildContext, so lastHeartbeatAt must be strictly later than
      // createdAt (which is set by the initial INSERT's defaultNow()).
      expect(run!.lastHeartbeatAt!.getTime()).toBeGreaterThan(
        run!.createdAt.getTime(),
      );
    });

    it("should store vars when provided", async () => {
      const vars = { MY_VAR: "value1", OTHER_VAR: "value2" };
      const data = await createTestRun(testComposeId, "Hello", { vars });

      const run = await findTestRunRecord(data.runId);

      expect(run!.vars).toEqual(vars);
    });

    it("should store secretNames when secrets provided", async () => {
      const secrets = { API_KEY: "sk-123", DB_PASS: "pw" };
      const data = await createTestRun(testComposeId, "Hello", { secrets });

      const run = await findTestRunRecord(data.runId);

      expect(run!.secretNames).toEqual(["API_KEY", "DB_PASS"]);
    });

    // Note: permissionPolicies → firewalls conversion requires connector resolution
    // which is a zero-layer concern. Tested via POST /api/zero/runs route.
  });

  describe("Validation", () => {
    it("should reject request without agentComposeId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Test prompt" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("agentComposeId");
    });

    it("should reject request without prompt", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentComposeId: testComposeId }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("prompt");
    });

    it("should reject request with both checkpointId and sessionId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "Test prompt",
            checkpointId: randomUUID(),
            sessionId: randomUUID(),
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("both checkpointId and sessionId");
    });

    it("should succeed when all required secrets are provided", async () => {
      // Create compose that requires secrets
      const { composeId: secretComposeId } = await createTestCompose(
        `secret-success-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              MY_SECRET: "${{ secrets.MY_SECRET }}",
            },
          },
        },
      );

      // Create run WITH required secrets
      const data = await createTestRun(secretComposeId, "Test with secrets", {
        secrets: { MY_SECRET: "secret-value" },
      });

      // Should succeed (pending, not failed)
      expect(data.status).toBe("pending");
    });

    // Note: auto-fetching secrets from database is a zero-layer concern.
    // CLI path requires all secrets to be passed explicitly.
    // Tested via POST /api/zero/runs route.

    it("should prefer CLI secrets over DB secrets", async () => {
      // Store a secret in the database
      const secretName = `OVERRIDE_SECRET_${Date.now()}`;
      await createTestSecret(secretName, "db-value");

      // Create compose that references the secret
      const { composeId } = await createTestCompose(
        `override-secret-test-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              MY_SECRET: `\${{ secrets.${secretName} }}`,
            },
          },
        },
      );

      // Pass the secret via CLI - should override DB value
      const data = await createTestRun(composeId, "Test CLI override", {
        secrets: { [secretName]: "cli-value" },
      });

      // Should succeed
      expect(data.status).toBe("pending");
    });

    it("should succeed when all required vars are provided", async () => {
      // Create compose that requires vars
      const { composeId: varsComposeId } = await createTestCompose(
        `vars-success-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              MY_VAR: "${{ vars.MY_VAR }}",
            },
          },
        },
      );

      // Create run WITH required vars
      const data = await createTestRun(varsComposeId, "Test with vars", {
        vars: { MY_VAR: "var-value" },
      });

      // Should succeed (pending, not failed)
      expect(data.status).toBe("pending");
    });
  });

  describe("Org Member Agent Access", () => {
    it("should allow running an org member agent", async () => {
      // User A creates an agent
      const ownerUser = user;

      // Switch to User B who is an org member
      const otherUser = await context.setupUser({ prefix: "other" });
      await insertOrgMembersCacheEntry({
        orgId: ownerUser.orgId,
        userId: otherUser.userId,
        cachedAt: new Date(),
      });

      // Set User B's active org to owner's org (simulates org selection in Clerk)
      mockClerk({ userId: otherUser.userId, orgId: ownerUser.orgId });

      // User B should be able to run the org member agent
      const data = await createTestRun(testComposeId, "Run org member agent");

      expect(data.status).toBe("pending");

      // Switch back to owner for cleanup
      mockClerk({ userId: ownerUser.userId });
    });

    it("should deny running private agent owned by another user", async () => {
      // User A creates an agent (private by default)
      const ownerUser = user;

      // Switch to User B (not an org member)
      await context.setupUser({ prefix: "other" });

      // User B should NOT be able to run the private agent
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Try to run private agent",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // Returns 404 to avoid leaking resource existence (cross-org check)
      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");

      // Switch back to owner for cleanup
      mockClerk({ userId: ownerUser.userId });
    });

    it("should succeed org member agent run with model provider", async () => {
      // User A (owner) creates an agent with a model provider configured
      const ownerUser = user;
      await createAnthropicModelPolicy(ownerUser.orgId);
      const { composeId: sharedComposeId } = await createTestCompose(
        uniqueId("shared-mp"),
        { skipDefaultApiKey: true },
      );

      // Switch to User B (runner) who is an org member
      const runnerUser = await context.setupUser({ prefix: "runner-mp" });
      await insertOrgMembersCacheEntry({
        orgId: ownerUser.orgId,
        userId: runnerUser.userId,
        cachedAt: new Date(),
      });

      // Set User B's active org to owner's org (simulates org selection in Clerk)
      mockClerk({ userId: runnerUser.userId, orgId: ownerUser.orgId });

      const data = await createTestRun(
        sharedComposeId,
        "Run with model provider",
      );

      expect(data.status).toBe("pending");

      // Switch back to owner for cleanup
      mockClerk({ userId: ownerUser.userId });
    });

    it("should deny running agent when user is not an org member", async () => {
      // User A creates an agent
      const ownerUser = user;

      // Switch to User B (not an org member)
      await context.setupUser({ prefix: "other" });

      // User B should NOT be able to run the agent
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Try to run without org membership",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // Returns 404 to avoid leaking resource existence (cross-org check)
      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");

      // Switch back to owner for cleanup
      mockClerk({ userId: ownerUser.userId });
    });
  });

  describe("Authorization", () => {
    it("should reject unauthenticated request", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Test prompt",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");
    });

    it("should reject request for non-existent compose", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: randomUUID(),
            prompt: "Test prompt",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.message).toContain("Agent compose");
    });
  });

  describe("CLI Token Authentication", () => {
    let testCliToken: string;

    beforeEach(async () => {
      testCliToken = await createTestCliToken(user.userId);
    });

    afterEach(async () => {
      await deleteTestCliToken(testCliToken);
    });

    it("should authenticate with valid CLI token", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${testCliToken}`,
          },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Test with CLI token",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.runId).toBeDefined();
      expect(data.status).toBe("pending");
    });

    it("should reject expired CLI token", async () => {
      const expiredToken = await createTestCliToken(
        user.userId,
        new Date(Date.now() - 1000),
      );
      mockClerk({ userId: null });

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${expiredToken}`,
          },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Test with expired token",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Not authenticated");

      await deleteTestCliToken(expiredToken);
    });
  });

  describe("Concurrent Run Limit", () => {
    it("should reject run with 429 when concurrent run limit is reached (CLI path)", async () => {
      // Free tier (default) allows only 1 concurrent run
      const run1 = await createTestRun(testComposeId, "First run");
      expect(run1.status).toBe("pending");

      // CLI path returns 429 error (queueing is a zero-layer concern)
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Second run",
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(429);
    });

    it("should allow unlimited runs when limit is 0", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();

      const run1 = await createTestRun(testComposeId, "Run 1");
      const run2 = await createTestRun(testComposeId, "Run 2");
      const run3 = await createTestRun(testComposeId, "Run 3");

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
      expect(run3.status).toBe("pending");
    });

    it("should only count pending and running statuses", async () => {
      // Free tier limit is 1; completed runs should not count
      const run1 = await createTestRun(testComposeId, "First run");
      expect(run1.status).toBe("pending");
      await completeTestRun(user.userId, run1.runId);

      // Second run should succeed since first is completed
      const run2 = await createTestRun(testComposeId, "Second run");
      expect(run2.status).toBe("pending");
    });

    it("should allow 2 concurrent runs for pro tier orgs", async () => {
      // Set org to pro tier (allows 2 concurrent runs)
      await updateOrgTier(user.orgId, "pro");

      const run1 = await createTestRun(testComposeId, "Run 1");
      const run2 = await createTestRun(testComposeId, "Run 2");

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
    });

    it("should reject 3rd concurrent run for pro tier orgs (CLI path)", async () => {
      // Pro tier only allows 2 concurrent runs
      await updateOrgTier(user.orgId, "pro");

      const run1 = await createTestRun(testComposeId, "Run 1");
      const run2 = await createTestRun(testComposeId, "Run 2");

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");

      // CLI path returns 429 error instead of queueing
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Run 3",
          }),
        },
      );
      const response = await POST(request);
      expect(response.status).toBe(429);
    });

    it("should not count stale pending runs toward concurrency limit", async () => {
      // Free tier limit is 1; stale pending runs should not count
      const { versionId } = await createTestCompose(uniqueId("stale"));

      // Insert a stale "pending" run (20 minutes old, past the 15-min TTL)
      // This simulates a run stuck in pending state that the cron job missed
      await seedStalePendingRun(user.userId, versionId);

      // New run should succeed because the stale pending run (>15min) is excluded
      const run = await createTestRun(testComposeId, "Should not be blocked");
      expect(run.status).toBe("pending");
    });

    it("should not count pending runs older than TTL toward concurrency limit", async () => {
      // Free tier limit is 1; stale pending runs (older than TTL) are excluded
      const runCreationTime = Date.now();

      // First run should succeed and stay pending
      const run1 = await createTestRun(testComposeId, "Long running task");
      expect(run1.status).toBe("pending");

      // Advance time past the pending TTL (16 minutes)
      // The first run is now stale and should be excluded from concurrency count
      context.mocks.dateNow.mockReturnValue(runCreationTime + 16 * 60 * 1000);

      // Second run should succeed because the stale pending run is excluded
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Should succeed",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.status).toBe("pending");
    });

    it("should allow multiple concurrent runs for team tier", async () => {
      await updateOrgTier(user.orgId, "team");

      // Create 3 concurrent runs to verify team tier allows more than pro tier (which allows 2)
      const run1 = await createTestRun(testComposeId, "Team run 1");
      const run2 = await createTestRun(testComposeId, "Team run 2");
      const run3 = await createTestRun(testComposeId, "Team run 3");

      expect(run1.status).toBe("pending");
      expect(run2.status).toBe("pending");
      expect(run3.status).toBe("pending");
    });

    it("should enforce limit per-org, not per-user", async () => {
      // Create a run in the default org (fills its free-tier slot)
      await createTestRun(testComposeId, "Org 1 run");

      // Create a second user with a different org
      const otherUser = await context.setupUser({ prefix: "org-user" });
      const otherCompose = await createTestCompose(uniqueId("other-agent"));

      // Run in the other org should succeed (separate org, separate limit)
      mockClerk({ userId: otherUser.userId });
      const data = await createTestRun(otherCompose.composeId, "Org 2 run");
      expect(data.status).toBe("pending");

      // Switch back to original user for cleanup
      mockClerk({ userId: user.userId });
    });
  });

  describe("Model Provider Injection", () => {
    it("should succeed when model provider is configured and no API key in compose", async () => {
      // Create org-level model provider (build-context resolves org-only)
      await createAnthropicModelPolicy(user.orgId);

      // Create compose without API key
      const { composeId } = await createTestCompose(uniqueId("mp-agent"), {
        skipDefaultApiKey: true,
      });

      const data = await createTestRun(composeId, "Test with model provider");

      expect(data.status).toBe("pending");
    });

    it("should fail when no model provider and no API key in compose", async () => {
      // Create compose without API key and no environment block
      const { composeId } = await createTestCompose(uniqueId("no-mp"), {
        noEnvironmentBlock: true,
      });

      // Resolution validates model providers before run creation —
      // error returned because there's no way to authenticate to the LLM.
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: composeId,
            prompt: "Test without model provider",
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("should skip injection when compose has explicit ANTHROPIC_API_KEY", async () => {
      // Compose with default API key should work without model provider
      const data = await createTestRun(testComposeId, "Test with explicit key");

      expect(data.status).toBe("pending");
    });

    it("should skip injection when compose has CLAUDE_CODE_USE_FOUNDRY", async () => {
      // Create compose with alternative auth method
      const { composeId } = await createTestCompose(uniqueId("foundry"), {
        overrides: {
          framework: "claude-code",
          environment: { CLAUDE_CODE_USE_FOUNDRY: "1" },
        },
      });

      const data = await createTestRun(composeId, "Test with Foundry auth");

      expect(data.status).toBe("pending");
    });

    it("should auto-inject model provider when no environment block exists", async () => {
      // Create org-level model provider (build-context resolves org-only)
      await createAnthropicModelPolicy(user.orgId);

      // Create compose with no environment block at all
      const { composeId } = await createTestCompose(
        `no-env-block-${Date.now()}`,
        {
          noEnvironmentBlock: true,
        },
      );

      const data = await createTestRun(
        composeId,
        "Test auto-inject no env block",
      );

      expect(data.status).toBe("pending");
    });

    it("should succeed when a model-first BYOK route is configured and no API key in compose", async () => {
      await createAnthropicModelPolicy(user.orgId);

      // Create compose without API key
      const { composeId } = await createTestCompose(
        `bedrock-success-${randomUUID().slice(0, 8)}`,
        {
          skipDefaultApiKey: true,
        },
      );

      const data = await createTestRun(composeId, "Test with bedrock provider");

      // Should succeed (not fail due to missing model provider)
      expect(data.status).toBe("pending");
    });
  });

  describe("Connector Injection", () => {
    // Note: connector secret injection is a zero-layer concern.
    // CLI path requires all secrets to be passed explicitly.
    // Tested via POST /api/zero/runs route.

    it("should not override user-provided GH_TOKEN secret with connector token", async () => {
      // Create a GitHub connector
      await createTestConnector({
        accessToken: "ghp-connector-token",
      });

      // Create compose with ${{ secrets.GH_TOKEN }} reference
      const { composeId } = await createTestCompose(uniqueId("gh-explicit"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-key",
            GH_TOKEN: "${{ secrets.GH_TOKEN }}",
          },
        },
      });

      // Provide GH_TOKEN via CLI secrets — should take precedence over connector
      const data = await createTestRun(composeId, "Test GH_TOKEN precedence", {
        secrets: { GH_TOKEN: "user-provided-token" },
      });
      expect(data.status).toBe("pending");
    });

    it("should not inject connector secrets when compose does not reference them", async () => {
      // Create a GitHub connector
      await createTestConnector({
        accessToken: "ghp-should-not-appear",
      });

      // Create compose WITHOUT any GH_TOKEN reference
      const { composeId } = await createTestCompose(uniqueId("gh-no-ref"));

      const data = await createTestRun(composeId, "Test no GH_TOKEN ref");
      expect(data.status).toBe("pending");
    });

    it("should work when no connectors are connected", async () => {
      // No connector setup - verify run still works
      const data = await createTestRun(
        testComposeId,
        "Test without connectors",
      );
      expect(data.status).toBe("pending");
    });

    // Note: Slack connector secret injection is a zero-layer concern.
    // Tested via POST /api/zero/runs route.

    it("should not override user-provided SLACK_TOKEN secret with Slack connector token", async () => {
      // Create a Slack connector
      await createTestConnector({
        type: "slack",
        accessToken: "xoxp-connector-token",
      });

      // Create compose with ${{ secrets.SLACK_TOKEN }} reference
      const { composeId } = await createTestCompose(
        uniqueId("slack-explicit"),
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              SLACK_TOKEN: "${{ secrets.SLACK_TOKEN }}",
            },
          },
        },
      );

      // Provide SLACK_TOKEN via CLI secrets — should take precedence over connector
      const data = await createTestRun(
        composeId,
        "Test SLACK_TOKEN precedence",
        {
          secrets: { SLACK_TOKEN: "user-provided-slack-token" },
        },
      );
      expect(data.status).toBe("pending");
    });
  });

  describe("Session Continue", () => {
    it("should return 404 when session not found", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: randomUUID(),
            prompt: "Continue session",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should return 404 when session belongs to different user (security)", async () => {
      // Create another user with their own compose and run
      const otherUser = await context.setupUser({ prefix: "other" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-agent-${Date.now()}`,
      );

      // Create and complete run for other user (creates session with conversation)
      const otherRun = await createTestRun(otherComposeId, "Other user run");
      const { agentSessionId } = await completeTestRun(
        otherUser.userId,
        otherRun.runId,
      );

      // Switch back to original user
      mockClerk({ userId: user.userId });

      // Try to continue other user's session
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: agentSessionId,
            prompt: "Continue other session",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // Returns 404 for security (don't leak session existence)
      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should return 404 when continuing session from a different org", async () => {
      // Create compose and run under user's default org (org A)
      const { runId } = await createTestRun(testComposeId, "Session run");
      const { agentSessionId } = await completeTestRun(user.userId, runId);

      // Switch to org B — different org for the same user
      const otherOrgId = uniqueId("org-other");
      const otherOrgSlug = uniqueId("org-other");
      await insertOrgCacheEntry({ orgId: otherOrgId, slug: otherOrgSlug });
      mockClerk({
        userId: user.userId,
        orgId: otherOrgId,
        orgSlug: otherOrgSlug,
        clerkOrgs: [{ id: otherOrgId, slug: otherOrgSlug, name: otherOrgSlug }],
      });

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: agentSessionId,
            prompt: "Cross-org continue",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should return 404 when creating new run against compose from a different org", async () => {
      // testComposeId belongs to user's default org (org A)
      // Switch to org B
      const otherOrgId = uniqueId("org-other");
      const otherOrgSlug = uniqueId("org-other");
      await insertOrgCacheEntry({ orgId: otherOrgId, slug: otherOrgSlug });
      mockClerk({
        userId: user.userId,
        orgId: otherOrgId,
        orgSlug: otherOrgSlug,
        clerkOrgs: [{ id: otherOrgId, slug: otherOrgSlug, name: otherOrgSlug }],
      });

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Cross-org new run",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    // Note: "Missing required secrets" validation is tested in the Validation
    // describe block above (lines 138-197).
  });

  describe("Eager Agent Session", () => {
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it("should return sessionId on first POST and persist it on agent_runs", async () => {
      const data = await createTestRun(testComposeId, "Eager session test");

      expect(data.status).toBe("pending");
      expect(data.sessionId).toBeDefined();
      expect(data.sessionId).toMatch(UUID_REGEX);

      const run = await findTestRunRecord(data.runId);
      expect(run?.sessionId).toBe(data.sessionId);

      const session = await getTestAgentSessionWithConversation(
        data.sessionId!,
      );
      expect(session).toBeDefined();
      expect(session?.userId).toBe(user.userId);
      expect(session?.agentComposeId).toBe(testComposeId);
      expect(session?.conversationId).toBeNull();
    });

    it("should reuse the existing session when continuing via sessionId", async () => {
      // First run establishes a session
      const first = await createTestRun(testComposeId, "First run");
      expect(first.sessionId).toBeDefined();

      // Bind a claude-code conversation (matches compose default framework)
      // and mark the run complete so continuation validation passes and the
      // concurrency limit does not block the follow-up run.
      const sandboxToken = await generateSandboxToken(
        user.userId,
        first.runId,
        "org-test",
      );
      const checkpointResponse = await checkpointWebhook(
        createTestRequest(
          "http://localhost:3000/api/webhooks/agent/checkpoints",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${sandboxToken}`,
            },
            body: JSON.stringify({
              runId: first.runId,
              cliAgentType: "claude-code",
              cliAgentSessionId: "reuse-session-test",
              cliAgentSessionHistoryHash:
                "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e",
            }),
          },
        ),
      );
      expect(checkpointResponse.status).toBe(200);

      const completeResponse = await completeWebhook(
        createTestRequest("http://localhost:3000/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sandboxToken}`,
          },
          body: JSON.stringify({ runId: first.runId, exitCode: 0 }),
        }),
      );
      expect(completeResponse.status).toBe(200);

      // Continue using the returned sessionId
      const continued = await createTestRun(testComposeId, "Continue run", {
        sessionId: first.sessionId,
      });

      expect(continued.sessionId).toBe(first.sessionId);

      const continuedRun = await findTestRunRecord(continued.runId);
      expect(continuedRun?.sessionId).toBe(first.sessionId);
    });

    it("should populate conversation_id after the checkpoint webhook fires", async () => {
      const created = await createTestRun(testComposeId, "Checkpoint flow");
      expect(created.sessionId).toBeDefined();

      const beforeCheckpoint = await getTestAgentSessionWithConversation(
        created.sessionId!,
      );
      expect(beforeCheckpoint?.conversationId).toBeNull();

      const { agentSessionId, conversationId } = await completeTestRun(
        user.userId,
        created.runId,
      );

      // The checkpoint webhook should bind the conversation to the pre-created
      // session (not allocate a new session).
      expect(agentSessionId).toBe(created.sessionId);

      const afterCheckpoint = await getTestAgentSessionWithConversation(
        created.sessionId!,
      );
      expect(afterCheckpoint?.conversationId).toBe(conversationId);
    });
  });

  describe("Checkpoint Resume", () => {
    it("should return 404 when checkpoint not found", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkpointId: randomUUID(),
            prompt: "Resume checkpoint",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should return 404 when checkpoint belongs to different user (security)", async () => {
      // Create another user with their own compose and run
      const otherUser = await context.setupUser({ prefix: "other-cp" });
      const { composeId: otherComposeId } = await createTestCompose(
        `other-cp-agent-${Date.now()}`,
      );

      // Create and complete run for other user (creates checkpoint)
      const otherRun = await createTestRun(otherComposeId, "Other user run");
      const { checkpointId } = await completeTestRun(
        otherUser.userId,
        otherRun.runId,
      );

      // Switch back to original user
      mockClerk({ userId: user.userId });

      // Try to resume other user's checkpoint
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkpointId,
            prompt: "Resume other checkpoint",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // Returns 404 for security (don't leak checkpoint existence)
      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should return 404 when resuming checkpoint from a different org", async () => {
      // Create compose and run under org A, then complete it (creates checkpoint)
      const { runId } = await createTestRun(testComposeId, "Checkpoint run");
      const { checkpointId } = await completeTestRun(user.userId, runId);

      // Switch to org B
      const otherOrgId = uniqueId("org-other");
      const otherOrgSlug = uniqueId("org-other");
      await insertOrgCacheEntry({ orgId: otherOrgId, slug: otherOrgSlug });
      mockClerk({
        userId: user.userId,
        orgId: otherOrgId,
        orgSlug: otherOrgSlug,
        clerkOrgs: [{ id: otherOrgId, slug: otherOrgSlug, name: otherOrgSlug }],
      });

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkpointId,
            prompt: "Cross-org checkpoint resume",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    // Note: "Missing required secrets" validation is tested in the Validation
    // describe block above.

    it("should store additionalVolumes in run record", async () => {
      const additionalVolumes = [
        { name: "my-data", version: "latest", mountPath: "/data" },
        { name: "my-config", mountPath: "/config" },
      ];

      const { runId } = await createTestRun(testComposeId, "Run with volumes", {
        additionalVolumes,
      });

      const record = await findTestRunRecord(runId);
      expect(record).toBeDefined();
      expect(record!.additionalVolumes).toEqual(additionalVolumes);
    });

    it("should store null additionalVolumes when not provided", async () => {
      const { runId } = await createTestRun(
        testComposeId,
        "Run without volumes",
      );

      const record = await findTestRunRecord(runId);
      expect(record).toBeDefined();
      expect(record!.additionalVolumes).toBeNull();
    });

    it("should not inject zeroAgents.customSkills into CLI run volumes", async () => {
      await bindCustomSkillToAgent(testComposeId, "my-skill");

      const { runId } = await createTestRun(
        testComposeId,
        "CLI run is skill-agnostic",
      );

      const record = await findTestRunRecord(runId);
      expect(record).toBeDefined();
      expect(record!.additionalVolumes).toBeNull();
    });
  });

  describe("Volume Resolution", () => {
    it("should fail run when volume references non-existent storage", async () => {
      // Create compose with volume that references a storage that doesn't exist
      const request = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: {
              version: "1.0",
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  environment: { ANTHROPIC_API_KEY: "test-key" },
                  volumes: ["data:/mnt/data"],
                },
              },
              volumes: {
                data: {
                  name: `nonexistent-storage-${Date.now()}`,
                  version: "latest",
                },
              },
            },
          }),
        },
      );
      const composeResponse = await createComposeRoute(request);
      const compose = await composeResponse.json();

      // Create run - should fail during storage resolution
      const data = await createTestRun(
        compose.composeId,
        "Test with missing storage",
      );

      expect(data.status).toBe("failed");

      // Verify error via API
      const run = await getTestRun(data.runId);
      expect(run.error).toContain("not found");
    });

    it("should fail run when volume definition is missing", async () => {
      // Create compose with volume that references an undefined volume
      // Use unique agent name to avoid content-addressed version collision
      // across tests (different users sharing the same version ID would
      // cause prepareForExecution to resolve the wrong compose's orgId).
      const agentName = uniqueId("vol-agent");
      const request = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: {
              version: "1.0",
              agents: {
                [agentName]: {
                  framework: "claude-code",
                  environment: { ANTHROPIC_API_KEY: "test-key" },
                  volumes: ["undefined-vol:/mnt/data"],
                },
              },
              // No volumes section - undefined-vol is not defined
            },
          }),
        },
      );
      const composeResponse = await createComposeRoute(request);
      const compose = await composeResponse.json();

      // Create run - should fail during volume resolution
      const data = await createTestRun(
        compose.composeId,
        "Test missing volume definition",
      );

      expect(data.status).toBe("failed");

      // Verify error mentions missing volume definition
      const run = await getTestRun(data.runId);
      expect(run.error).toMatch(/volume resolution failed/i);
      expect(run.error).toContain("undefined-vol");
    });
  });

  describe("Server-Stored Variables", () => {
    /**
     * Helper to create a server-stored variable
     */
    async function createVariable(name: string, value: string): Promise<void> {
      await insertTestUserVariable({
        orgId: user.orgId,
        userId: user.userId,
        name,
        value,
      });
    }

    it("should succeed when required vars are stored on server (not provided via CLI)", async () => {
      // Create compose that requires a template variable
      const { composeId } = await createTestCompose(uniqueId("server-var"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-key",
            MY_VAR: "${{ vars.MY_VAR }}",
          },
        },
      });

      // Create server-stored variable (simulating: vm0 variable set MY_VAR my-value)
      await createVariable("MY_VAR", "server-stored-value");

      // Create run WITHOUT providing the variable via CLI --vars
      // This should succeed because server-stored variables are fetched and merged
      const data = await createTestRun(
        composeId,
        "Test with server-stored var",
      );

      expect(data.status).toBe("pending");
    });

    it("should use CLI vars over server-stored vars when both exist", async () => {
      // Create compose that requires a template variable
      const { composeId } = await createTestCompose(uniqueId("cli-override"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-key",
            MY_VAR: "${{ vars.MY_VAR }}",
          },
        },
      });

      // Create server-stored variable
      await createVariable("MY_VAR", "server-value");

      // Create run WITH CLI --vars (should override server value)
      const data = await createTestRun(composeId, "Test CLI override", {
        vars: { MY_VAR: "cli-value" },
      });

      expect(data.status).toBe("pending");
    });
  });

  describe("Sandbox Token Capability Enforcement", () => {
    it("should accept sandbox token with agent-run:read for list", async () => {
      // Refresh org and member caches with current Date.now() timestamp
      // (a previous test may have advanced Date.now via dateNow mock,
      // making older cache entries appear stale)
      await insertOrgCacheEntry({
        orgId: user.orgId,
        slug: (await getOrgCacheEntry(user.orgId))!.slug,
        cachedAt: new Date(Date.now()),
      });
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: user.userId,
        cachedAt: new Date(Date.now()),
      });

      // Create a run via DB (needs Clerk mock for compose lookup)
      const { runId } = await seedTestRun(user.userId, testComposeId);

      // Now switch to sandbox auth (no Clerk session)
      mockClerk({ userId: null });

      const token = await generateZeroToken(user.userId, runId, user.orgId);

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs?limit=10",
        { headers: { authorization: `Bearer ${token}` } },
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it("should accept sandbox token with any capability for list", async () => {
      // Refresh org and member caches so sandbox token can resolve org
      await insertOrgCacheEntry({
        orgId: user.orgId,
        slug: (await getOrgCacheEntry(user.orgId))!.slug,
        cachedAt: new Date(Date.now()),
      });
      await insertOrgMembersCacheEntry({
        orgId: user.orgId,
        userId: user.userId,
        cachedAt: new Date(Date.now()),
      });

      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs?limit=10",
        { headers: { authorization: `Bearer ${token}` } },
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it("should accept sandbox token with agent-run:write for create", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(
        user.userId,
        "run-1",
        "org-test",
      );

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "sandbox test",
          }),
        },
      );
      const response = await POST(request);

      // Should pass auth (not 403) — downstream may fail for other reasons
      expect(response.status).not.toBe(403);
    });

    it("should accept sandbox token with any capability for create", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(
        user.userId,
        "run-1",
        "org-test",
      );

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "sandbox test",
          }),
        },
      );
      const response = await POST(request);

      // Should pass auth (not 403) — downstream may fail for other reasons
      expect(response.status).not.toBe(403);
    });
  });

  describe("Memory", () => {
    it("should succeed when memory-as-artifact already exists (idempotent)", async () => {
      // Allow concurrent runs for this test
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();

      const memoryArtifact = uniqueId("existing-mem");
      const memoryBody = {
        agentComposeId: testComposeId,
        artifacts: [
          { name: memoryArtifact, mountPath: AUTO_MEMORY_MOUNT_PATH },
        ],
      };

      // First run creates the memory artifact
      const firstRequest = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...memoryBody, prompt: "First run" }),
        },
      );
      const firstResponse = await POST(firstRequest);
      expect(firstResponse.status).toBe(201);

      // Second run should also succeed (idempotent)
      const secondRequest = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...memoryBody, prompt: "Second run" }),
        },
      );
      const secondResponse = await POST(secondRequest);
      const data = await secondResponse.json();

      expect(secondResponse.status).toBe(201);
      expect(data.runId).toBeDefined();
      expect(data.status).toBe("pending");
    });
  });

  describe("Auto-Create Artifact", () => {
    it("should succeed when artifact does not exist (auto-create)", async () => {
      const artifactName = uniqueId("new-art");
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Test artifact auto-create",
            artifacts: [{ name: artifactName, mountPath: "/mnt/work" }],
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.status).toBe("pending");
    });

    it("should succeed when artifact already exists", async () => {
      const artifactName = uniqueId("existing-art");
      await createTestArtifact(artifactName);

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Test existing artifact",
            artifacts: [{ name: artifactName, mountPath: "/mnt/work" }],
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.status).toBe("pending");
    });
  });

  describe("Multi-Mount Artifacts (body.artifacts)", () => {
    it("should pipe body.artifacts through storage manifest", async () => {
      // Pre-seed two artifacts so the unified resolver finds real storages.
      const artifactA = uniqueId("multi-art-a");
      const artifactB = uniqueId("multi-art-b");
      await createTestArtifact(artifactA);
      await createTestArtifact(artifactB);

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Multi-mount artifact test",
            artifacts: [
              { name: artifactA, mountPath: "/mnt/a" },
              { name: artifactB, mountPath: "/mnt/b" },
            ],
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.status).toBe("pending");

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      // Zero also auto-injects "memory" at its well-known mount, so the
      // manifest carries three entries: the two body artifacts plus memory.
      const artifacts = job!.executionContext.storageManifest!.artifacts;
      const userArtifacts = artifacts.filter((a) => {
        return a.vasStorageName !== "memory";
      });
      expect(userArtifacts).toHaveLength(2);
      const mountPaths = userArtifacts.map((a) => {
        return a.mountPath;
      });
      expect(mountPaths).toContain("/mnt/a");
      expect(mountPaths).toContain("/mnt/b");
      const names = userArtifacts.map((a) => {
        return a.vasStorageName;
      });
      expect(names).toContain(artifactA);
      expect(names).toContain(artifactB);
    });

    it("should persist body.artifacts into agent_sessions.artifacts for new runs", async () => {
      // Regression for issue #10861: on the new-run path the session row must
      // be seeded with the artifact list from body.artifacts so that a later
      // `continue` can resolve the mount set. Previously insertRunRecord was
      // fed an empty resolved.artifacts map and wrote [] into the session.
      // Memory is also persisted alongside body.artifacts — the auto-memory
      // entry added by resolveCliRunContext must survive into the session row
      // so future resumes can rebuild the artifact manifest.
      const primary = uniqueId("session-art");
      await createTestArtifact(primary);

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Session artifacts seeding",
            artifacts: [{ name: primary, mountPath: "/home/user/workspace" }],
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();
      expect(response.status).toBe(201);

      const run = await findTestRunRecord(data.runId);
      expect(run?.sessionId).toBeTruthy();

      const sessionRequest = createTestRequest(
        `http://localhost:3000/api/agent/sessions/${run!.sessionId!}`,
      );
      const sessionResponse = await getSessionById(sessionRequest);
      const sessionBody = await sessionResponse.json();
      expect(sessionResponse.status).toBe(200);
      expect(sessionBody.artifactNames).toEqual(
        expect.arrayContaining([primary, "memory"]),
      );
      expect(sessionBody.artifactNames).toHaveLength(2);
    });
  });

  describe("Optional Volumes", () => {
    /**
     * Helper to create a compose with volume configuration
     */
    async function createComposeWithVolumes(
      agentName: string,
      volumes: AgentComposeYaml["volumes"],
      agentVolumes: string[],
    ) {
      const config: AgentComposeYaml = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "test-api-key" },
            volumes: agentVolumes,
          },
        },
        volumes,
      };

      const request = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: config }),
        },
      );
      const response = await createComposeRoute(request);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          `Failed to create compose: ${error.error?.message || response.status}`,
        );
      }
      return response.json() as Promise<{
        composeId: string;
        versionId: string;
      }>;
    }

    it("should succeed when optional volume exists", async () => {
      const volumeName = uniqueId("vol");
      await createTestVolume(volumeName);

      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: volumeName,
            version: "latest",
            optional: true,
          },
        },
        ["mydata:/data"],
      );

      const data = await createTestRun(compose.composeId, "Test optional vol");
      expect(data.status).toBe("pending");
    });

    it("should succeed when optional volume does not exist (skip silently)", async () => {
      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: "nonexistent-volume",
            version: "latest",
            optional: true,
          },
        },
        ["mydata:/data"],
      );

      const data = await createTestRun(
        compose.composeId,
        "Test missing optional vol",
      );
      expect(data.status).toBe("pending");
    });

    it("should skip optional volume during checkpoint resume when it was skipped originally", async () => {
      const volumeName = uniqueId("vol");

      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: volumeName,
            version: "latest",
            optional: true,
          },
        },
        ["mydata:/data"],
      );

      // Simulate checkpoint resume: volumeVersions is provided but does NOT
      // include the optional volume (meaning it was skipped at checkpoint time)
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: compose.composeId,
            prompt: "Checkpoint resume",
            volumeVersions: {},
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.status).toBe("pending");
    });

    it("should mount optional volume in session/continue when it now exists (no volumeVersions)", async () => {
      const volumeName = uniqueId("vol");
      await createTestVolume(volumeName);

      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          mydata: {
            name: volumeName,
            version: "latest",
            optional: true,
          },
        },
        ["mydata:/data"],
      );

      // Session/Continue: volumeVersions is NOT provided — use current config
      const data = await createTestRun(
        compose.composeId,
        "Session continue with vol",
      );
      expect(data.status).toBe("pending");
    });

    it("should succeed with mixed volumes (required exists, optional missing)", async () => {
      const requiredVolumeName = uniqueId("required-vol");
      await createTestVolume(requiredVolumeName);

      const compose = await createComposeWithVolumes(
        uniqueId("agent"),
        {
          requiredData: {
            name: requiredVolumeName,
            version: "latest",
          },
          optionalData: {
            name: "nonexistent-optional-volume",
            version: "latest",
            optional: true,
          },
        },
        ["requiredData:/required", "optionalData:/optional"],
      );

      const data = await createTestRun(compose.composeId, "Test mixed volumes");
      expect(data.status).toBe("pending");
    });
  });

  describe("Runner Default Group Routing", () => {
    it("should route all users to runner when RUNNER_DEFAULT_GROUP is set", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      mockClerk({ userId: user.userId, email: "user@example.com" });

      const data = await createTestRun(testComposeId, "Runner routing test");

      expect(data.status).toBe("pending");
    });

    it("should use default executor when RUNNER_DEFAULT_GROUP is not set", async () => {
      // RUNNER_DEFAULT_GROUP is not set by default in test env
      mockClerk({ userId: user.userId, email: "team@vm0.ai" });

      const data = await createTestRun(testComposeId, "Default executor test");

      expect(data.status).toBe("pending");
    });

    it("should mark run as failed when runner group is not vm0/*", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "nonexistent-org/default");
      reloadEnv();

      mockClerk({ userId: user.userId, email: "user@example.com" });

      // Route returns 201 with failed status for post-INSERT dispatch errors
      const data = await createTestRun(testComposeId, "Bad runner group test");
      expect(data.status).toBe("failed");

      // Verify the run is marked as "failed" in the database
      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe("failed");
      expect(run!.error).toMatch(/vm0/);
    });
  });

  describe("Experimental Profile", () => {
    it("should store profile in runner job queue when experimental_profile is set", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const compose = await createTestCompose(uniqueId("profile-agent"), {
        overrides: { experimental_profile: "vm0/default" },
      });

      const data = await createTestRun(compose.composeId, "Profile test");

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      expect(job!.profile).toBe("vm0/default");
      expect(job!.executionContext.experimentalProfile).toBe("vm0/default");
    });

    it("should default to vm0/default when experimental_profile is not set", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const data = await createTestRun(testComposeId, "Default profile test");

      const job = await findTestRunnerJobEntry(data.runId);
      expect(job).toBeDefined();
      expect(job!.profile).toBe("vm0/default");
      expect(job!.executionContext.experimentalProfile).toBe("vm0/default");
    });

    it("should filter jobs by profiles array in poll endpoint", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      vi.stubEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
      reloadEnv();

      // Create two runs — one with default profile, one with explicit profile
      const browserCompose = await createTestCompose(
        uniqueId("browser-agent"),
        { overrides: { experimental_profile: "vm0/default" } },
      );
      await createTestRun(testComposeId, "default job");
      await createTestRun(browserCompose.composeId, "browser job");

      // Poll with profiles filter for a non-existent profile — should find nothing
      const officialToken = `vm0_official_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
      const emptyPoll = await pollRoute(
        createTestRequest("http://localhost:3000/api/runners/poll", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${officialToken}`,
          },
          body: JSON.stringify({
            group: "vm0/production",
            profiles: ["vm0/nonexistent"],
          }),
        }),
      );
      const emptyResult = await emptyPoll.json();
      expect(emptyResult.job).toBeNull();

      // Poll without profiles filter — should find a job
      const allPoll = await pollRoute(
        createTestRequest("http://localhost:3000/api/runners/poll", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${officialToken}`,
          },
          body: JSON.stringify({ group: "vm0/production" }),
        }),
      );
      const allResult = await allPoll.json();
      expect(allResult.job).not.toBeNull();
      expect(allResult.job.experimentalProfile).toBe("vm0/default");
    });

    it("should reject unknown profile with failed status", async () => {
      vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
      reloadEnv();

      const compose = await createTestCompose(uniqueId("bad-profile"), {
        overrides: { experimental_profile: "vm0/unknown" },
      });

      // Route returns 201 with failed status for post-INSERT dispatch errors
      const data = await createTestRun(compose.composeId, "Bad profile test");
      expect(data.status).toBe("failed");
    });
  });

  describe("Org Resolution for Storage", () => {
    it("should use compose org for artifact/memory storage", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Storage org test",
            artifacts: [
              { name: "artifact", mountPath: "/mnt/work" },
              { name: "memory", mountPath: AUTO_MEMORY_MOUNT_PATH },
            ],
          }),
        },
      );
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.status).toBe("pending");

      // Verify the run record was created
      const run = await findTestRunRecord(data.runId);
      expect(run).toBeDefined();

      // Both artifact entries (including the one mounted at the auto-memory
      // path) auto-create storage in the compose's org (user's default org).
      const artifact = await findTestStorage(
        user.orgId,
        "artifact",
        "artifact",
      );
      expect(artifact).toBeDefined();
      expect(artifact!.userId).toBe(user.userId);

      const memory = await findTestStorage(user.orgId, "memory", "artifact");
      expect(memory).toBeDefined();
      expect(memory!.userId).toBe(user.userId);
    });
  });

  // NOTE: The following tests from create-run.test.ts are NOT migrated:
  // 1. "should reject second run when concurrency limit reached" (Promise.allSettled)
  //    — Tests advisory lock serialization (internal DB concern). Route test covers
  //    the user-facing 429 response for concurrency limits.
  // 2. "should register callbacks when provided"
  //    — `callbacks` field is not in the route's ts-rest contract. CLI-only concern.
});

describe("GET /api/agent/runs - List Runs", () => {
  const context = testContext();
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    const { composeId } = await createTestCompose(uniqueId("list-agent"));
    testComposeId = composeId;
  });

  it("should return runs belonging to the user's org", async () => {
    await seedTestRun(user.userId, testComposeId, {
      status: "running",
      prompt: "Org A run",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs?status=running&limit=50",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.runs.length).toBeGreaterThanOrEqual(1);
    expect(
      data.runs.some((r: { prompt: string }) => {
        return r.prompt === "Org A run";
      }),
    ).toBe(true);
  });

  it("should not return runs from a different org", async () => {
    // Create a run in the user's default org
    await seedTestRun(user.userId, testComposeId, {
      status: "running",
      prompt: "Default org run",
    });

    // Create a compose + run in a different org
    const otherOrg = await context.createAgentCompose(user.userId);
    await seedTestRun(user.userId, otherOrg.id, {
      status: "running",
      prompt: "Other org run",
    });

    // List runs — should only see runs from the default org
    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs?status=running&limit=50",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const prompts = data.runs.map((r: { prompt: string }) => {
      return r.prompt;
    });
    expect(prompts).toContain("Default org run");
    expect(prompts).not.toContain("Other org run");
  });

  it("should filter runs by org context", async () => {
    // Create a compose + run in a different org
    const otherOrg = await context.createAgentCompose(user.userId);
    await seedTestRun(user.userId, otherOrg.id, {
      status: "running",
      prompt: "Target org run",
    });

    // Look up the other org's slug
    const orgEntry = await getOrgCacheEntry(otherOrg.orgId);

    // Switch Clerk mock to be a member of the other org
    mockClerk({
      userId: user.userId,
      orgId: otherOrg.orgId,
      orgSlug: orgEntry!.slug,
      clerkOrgs: [
        { id: otherOrg.orgId, slug: orgEntry!.slug, name: orgEntry!.slug },
      ],
    });

    const request = createTestRequest(
      "http://localhost:3000/api/agent/runs?status=running&limit=50",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const prompts = data.runs.map((r: { prompt: string }) => {
      return r.prompt;
    });
    expect(prompts).toContain("Target org run");
  });

  describe("captureNetworkBodies gate", () => {
    it("should reject non-vm0.ai accounts in production", async () => {
      // Use a fresh user so user_cache is empty for this email
      const freshUser = await context.setupUser({ prefix: "capture-ext" });
      mockClerk({ userId: freshUser.userId, email: "external@gmail.com" });
      const { composeId } = await createTestCompose(uniqueId("cap-agent"));

      vi.stubEnv("VERCEL_ENV", "production");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: composeId,
            prompt: "Test capture",
            captureNetworkBodies: true,
          }),
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(403);
    });

    it("should allow vm0.ai accounts in production", async () => {
      const freshUser = await context.setupUser({ prefix: "capture-int" });
      mockClerk({ userId: freshUser.userId, email: "team@vm0.ai" });
      const { composeId } = await createTestCompose(uniqueId("cap-agent"));

      vi.stubEnv("VERCEL_ENV", "production");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: composeId,
            prompt: "Test capture",
            captureNetworkBodies: true,
          }),
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(201);
    });

    it("should allow any account in non-production", async () => {
      // Default VERCEL_ENV is not "production" in test env
      const freshUser = await context.setupUser({ prefix: "capture-dev" });
      mockClerk({ userId: freshUser.userId, email: "external@gmail.com" });
      const { composeId } = await createTestCompose(uniqueId("cap-agent"));

      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: composeId,
            prompt: "Test capture",
            captureNetworkBodies: true,
          }),
        },
      );
      const response = await POST(request);

      expect(response.status).toBe(201);
    });
  });
});
