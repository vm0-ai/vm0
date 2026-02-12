import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { POST as createComposeRoute } from "../../composes/route";
import { PUT as putSecret } from "../../../secrets/route";
import { PUT as setVariableRoute } from "../../../variables/route";
import { randomUUID } from "crypto";
import { Sandbox } from "@e2b/code-interpreter";
import {
  createTestRequest,
  createTestCompose,
  createTestCliToken,
  deleteTestCliToken,
  createTestModelProvider,
  createTestMultiAuthModelProvider,
  createTestConnector,
  createTestRun,
  getTestRun,
  completeTestRun,
  createTestPermission,
  insertStalePendingRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../src/env";

const context = testContext();

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
    it("should return immediately with running status", async () => {
      const startTime = Date.now();
      const data = await createTestRun(testComposeId, "Test prompt");
      const responseTime = Date.now() - startTime;

      // Should return quickly (sandbox prep only, not agent execution)
      expect(responseTime).toBeLessThan(5000);
      expect(data.runId).toBeDefined();
      expect(data.status).toBe("running");
    });

    it("should create run with running status", async () => {
      const data = await createTestRun(testComposeId, "Test run creation");

      // Verify via API
      const run = await getTestRun(data.runId);

      expect(run.status).toBe("running");
      expect(run.completedAt).toBeNull();
    });

    it("should return failed status if sandbox preparation fails", async () => {
      vi.mocked(Sandbox.create).mockRejectedValueOnce(
        new Error("Sandbox creation failed"),
      );

      const data = await createTestRun(testComposeId, "Test failure");

      expect(data.status).toBe("failed");

      // Verify via API
      const run = await getTestRun(data.runId);

      expect(run.status).toBe("failed");
      expect(run.error).toContain("Sandbox creation failed");
      expect(run.completedAt).toBeDefined();
    });
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

    it("should fail run when only some secrets are provided", async () => {
      // Create compose that requires multiple secrets
      const { composeId: multiSecretComposeId } = await createTestCompose(
        `multi-secret-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              SECRET_A: "${{ secrets.SECRET_A }}",
              SECRET_B: "${{ secrets.SECRET_B }}",
            },
          },
        },
      );

      // Try to create run with only one secret
      // Pass checkEnv: true to enable server-side validation
      const data = await createTestRun(
        multiSecretComposeId,
        "Test with partial secrets",
        { secrets: { SECRET_A: "value-a" }, checkEnv: true }, // Missing SECRET_B
      );

      // Route creates run first, then fails during preparation
      expect(data.status).toBe("failed");

      // Verify error via API
      const run = await getTestRun(data.runId);

      expect(run.error).toMatch(/Missing required secrets/i);
      expect(run.error).toContain("SECRET_B");
      // SECRET_A should NOT be in the error (it was provided)
      expect(run.error).not.toContain("SECRET_A");
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

      // Should succeed (running, not failed)
      expect(data.status).toBe("running");
    });

    it("should auto-fetch secrets from database when secrets.* is referenced", async () => {
      // Store a secret in the database first
      const secretName = `DB_SECRET_${Date.now()}`;
      const createSecretRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: secretName,
            value: "db-secret-value",
          }),
        },
      );
      await putSecret(createSecretRequest);

      // Create compose that references the secret
      const { composeId } = await createTestCompose(
        `db-secret-test-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              MY_SECRET: `\${{ secrets.${secretName} }}`,
            },
          },
        },
      );

      // Run WITHOUT passing the secret via CLI - should auto-fetch from DB
      const data = await createTestRun(composeId, "Test DB secret auto-fetch");

      // Should succeed (running, not failed)
      expect(data.status).toBe("running");
    });

    it("should prefer CLI secrets over DB secrets", async () => {
      // Store a secret in the database
      const secretName = `OVERRIDE_SECRET_${Date.now()}`;
      const createSecretRequest = createTestRequest(
        "http://localhost:3000/api/secrets",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: secretName,
            value: "db-value",
          }),
        },
      );
      await putSecret(createSecretRequest);

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
      expect(data.status).toBe("running");
    });

    it("should reject run when only some vars are provided with checkEnv", async () => {
      // Create compose that requires multiple vars
      const { composeId: multiVarsComposeId } = await createTestCompose(
        `multi-vars-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              VAR_A: "${{ vars.VAR_A }}",
              VAR_B: "${{ vars.VAR_B }}",
            },
          },
        },
      );

      // Try to create run with only one var AND checkEnv: true
      // Vars validation only happens when checkEnv is enabled
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: multiVarsComposeId,
            prompt: "Test with partial vars",
            vars: { VAR_A: "value-a" }, // Missing VAR_B
            checkEnv: true,
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // API validates template variables when checkEnv is true
      expect(response.status).toBe(400);
      expect(data.error.message).toContain("VAR_B");
      // VAR_A should NOT be in the error (it was provided)
      expect(data.error.message).not.toContain("VAR_A");
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

      // Should succeed (running, not failed)
      expect(data.status).toBe("running");
    });
  });

  describe("Shared Agent Access", () => {
    it("should allow running a public shared agent", async () => {
      // User A creates an agent and makes it public
      const ownerUser = user;
      await createTestPermission(testComposeId, "public");

      // Switch to User B
      await context.setupUser({ prefix: "other" });

      // User B should be able to run the public agent
      const data = await createTestRun(testComposeId, "Run public agent");

      expect(data.status).toBe("running");

      // Switch back to owner for cleanup
      mockClerk({ userId: ownerUser.userId });
    });

    it("should allow running an email-shared agent", async () => {
      // User A creates an agent and shares with specific email
      const ownerUser = user;
      const sharedEmail = "test@example.com"; // Default mock email
      await createTestPermission(testComposeId, "email", sharedEmail);

      // Switch to User B (who has the shared email via mock)
      await context.setupUser({ prefix: "other" });

      // User B should be able to run the shared agent
      const data = await createTestRun(testComposeId, "Run email-shared agent");

      expect(data.status).toBe("running");

      // Switch back to owner for cleanup
      mockClerk({ userId: ownerUser.userId });
    });

    it("should deny running private agent owned by another user", async () => {
      // User A creates an agent (private by default)
      const ownerUser = user;

      // Switch to User B
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

      // Returns 403 Forbidden for unauthorized access
      expect(response.status).toBe(403);
      expect(data.error.message).toMatch(
        /access denied|not authorized|permission/i,
      );

      // Switch back to owner for cleanup
      mockClerk({ userId: ownerUser.userId });
    });

    it("should deny running agent when email does not match", async () => {
      // User A creates an agent and shares with different email
      const ownerUser = user;
      await createTestPermission(
        testComposeId,
        "email",
        "different@example.com",
      );

      // Switch to User B (who has test@example.com, NOT the shared email)
      await context.setupUser({ prefix: "other" });

      // User B should NOT be able to run the agent
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Try to run with wrong email",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // Returns 403 Forbidden for unauthorized access
      expect(response.status).toBe(403);
      expect(data.error.message).toMatch(
        /access denied|not authorized|permission/i,
      );

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
      expect(data.status).toBe("running");
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
    it("should return 429 when concurrent run limit is reached", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // First run should succeed
      const run1 = await createTestRun(testComposeId, "First run");
      expect(run1.status).toBe("running");

      // Second run should fail with 429
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
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.error.message).toMatch(/concurrent/i);
    });

    it("should allow unlimited runs when limit is 0", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "0");
      reloadEnv();

      const run1 = await createTestRun(testComposeId, "Run 1");
      const run2 = await createTestRun(testComposeId, "Run 2");
      const run3 = await createTestRun(testComposeId, "Run 3");

      expect(run1.status).toBe("running");
      expect(run2.status).toBe("running");
      expect(run3.status).toBe("running");
    });

    it("should only count pending and running statuses", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // Create and complete first run
      const run1 = await createTestRun(testComposeId, "First run");
      expect(run1.status).toBe("running");
      await completeTestRun(user.userId, run1.runId);

      // Second run should succeed since first is completed
      const run2 = await createTestRun(testComposeId, "Second run");
      expect(run2.status).toBe("running");
    });

    it("should respect higher limit values", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "3");
      reloadEnv();

      const run1 = await createTestRun(testComposeId, "Run 1");
      const run2 = await createTestRun(testComposeId, "Run 2");
      const run3 = await createTestRun(testComposeId, "Run 3");

      expect(run1.status).toBe("running");
      expect(run2.status).toBe("running");
      expect(run3.status).toBe("running");

      // Fourth run should fail
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Fourth run",
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(429);
    });

    it("should not count stale pending runs toward concurrency limit", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // Get a valid agentComposeVersionId from an existing compose
      const { versionId } = await createTestCompose(uniqueId("stale"));

      // Insert a stale "pending" run (20 minutes old, past the 15-min TTL)
      // This simulates a run stuck in pending state that the cron job missed
      await insertStalePendingRun(user.userId, versionId);

      // New run should succeed because the stale pending run (>15min) is excluded
      const run = await createTestRun(testComposeId, "Should not be blocked");
      expect(run.status).toBe("running");
    });

    it("should still count running runs older than TTL toward concurrency limit", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");
      reloadEnv();

      // Record time when run is created
      const runCreationTime = Date.now();

      // First run should succeed and stay running
      const run1 = await createTestRun(testComposeId, "Long running task");
      expect(run1.status).toBe("running");

      // Advance time past the pending TTL (16 minutes)
      // Running runs should STILL count regardless of age
      context.mocks.dateNow.mockReturnValue(runCreationTime + 16 * 60 * 1000);

      // Second run should still fail because the first run is "running"
      // (running runs are always counted, even if older than TTL)
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: testComposeId,
            prompt: "Should be blocked",
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(429);
    });
  });

  describe("Model Provider Injection", () => {
    it("should succeed when model provider is configured and no API key in compose", async () => {
      // Create model provider
      await createTestModelProvider("anthropic-api-key", "test-api-key");

      // Create compose without API key
      const { composeId } = await createTestCompose(uniqueId("mp-agent"), {
        skipDefaultApiKey: true,
      });

      const data = await createTestRun(composeId, "Test with model provider");

      expect(data.status).toBe("running");
    });

    it("should fail run when no model provider and no API key in compose", async () => {
      // Create compose without API key and no environment block
      const { composeId } = await createTestCompose(uniqueId("no-mp"), {
        noEnvironmentBlock: true,
      });

      const data = await createTestRun(
        composeId,
        "Test without model provider",
      );

      // Route creates run first, then fails during preparation
      expect(data.status).toBe("failed");

      // Verify error via API
      const run = await getTestRun(data.runId);

      expect(run.error).toMatch(/model provider/i);
    });

    it("should skip injection when compose has explicit ANTHROPIC_API_KEY", async () => {
      // Compose with default API key should work without model provider
      const data = await createTestRun(testComposeId, "Test with explicit key");

      expect(data.status).toBe("running");
    });

    it("should use specified model provider when passed", async () => {
      // Create model provider
      await createTestModelProvider("anthropic-api-key", "test-api-key");

      // Create compose without API key
      const { composeId } = await createTestCompose(uniqueId("mp-select"), {
        skipDefaultApiKey: true,
      });

      const data = await createTestRun(
        composeId,
        "Test with specified provider",
        {
          modelProvider: "anthropic-api-key",
        },
      );

      expect(data.status).toBe("running");
    });

    it("should skip injection when compose has explicit OPENAI_API_KEY (codex)", async () => {
      // Create compose with OPENAI_API_KEY for codex framework
      const { composeId } = await createTestCompose(uniqueId("codex"), {
        overrides: {
          framework: "codex",
          environment: { OPENAI_API_KEY: "explicit-openai-key" },
        },
      });

      const data = await createTestRun(composeId, "Test codex with key");

      expect(data.status).toBe("running");
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

      expect(data.status).toBe("running");
    });

    it("should fail when specified model provider type is invalid", async () => {
      // Create compose without API key
      const { composeId } = await createTestCompose(uniqueId("invalid-mp"), {
        skipDefaultApiKey: true,
      });

      const data = await createTestRun(
        composeId,
        "Test with invalid provider",
        {
          modelProvider: "non-existent-provider",
        },
      );

      // Route creates run first, then fails during preparation
      expect(data.status).toBe("failed");

      // Verify error via API
      const run = await getTestRun(data.runId);

      expect(run.error).toMatch(/model provider/i);
    });

    it("should auto-inject model provider when no environment block exists", async () => {
      // Create model provider
      await createTestModelProvider(
        "claude-code-oauth-token",
        "test-oauth-token",
      );

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

      expect(data.status).toBe("running");
    });

    it("should succeed when aws-bedrock provider is configured and no API key in compose", async () => {
      // Create aws-bedrock provider
      await createTestMultiAuthModelProvider("aws-bedrock", "api-key", {
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
        AWS_REGION: "us-east-1",
      });

      // Create compose without API key
      const { composeId } = await createTestCompose(
        `bedrock-success-${randomUUID().slice(0, 8)}`,
        {
          skipDefaultApiKey: true,
        },
      );

      const data = await createTestRun(composeId, "Test with bedrock provider");

      // Should succeed (not fail due to missing model provider)
      expect(data.status).toBe("running");
    });
  });

  describe("Connector Injection", () => {
    it("should satisfy ${{ secrets.GH_TOKEN }} from connector when user has no GH_TOKEN secret", async () => {
      vi.mocked(Sandbox.create).mockClear();

      // Create a GitHub connector for the test user
      await createTestConnector(user.scopeId, {
        accessToken: "ghp-test-connector-token",
      });

      // Create compose with explicit ${{ secrets.GH_TOKEN }} reference (real-world scenario from skills)
      const { composeId } = await createTestCompose(uniqueId("gh-connector"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-key",
            GH_TOKEN: "${{ secrets.GH_TOKEN }}",
          },
        },
      });

      const data = await createTestRun(composeId, "Test with GitHub connector");
      expect(data.status).toBe("running");

      // Verify Sandbox.create was called with the connector's token as GH_TOKEN
      expect(Sandbox.create).toHaveBeenCalled();
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      const envs = createCall?.[1]?.envs as Record<string, string> | undefined;

      expect(envs?.GH_TOKEN).toBe("ghp-test-connector-token");
    });

    it("should not override user-provided GH_TOKEN secret with connector token", async () => {
      vi.mocked(Sandbox.create).mockClear();

      // Create a GitHub connector
      await createTestConnector(user.scopeId, {
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
      expect(data.status).toBe("running");

      // Verify user-provided secret takes precedence
      expect(Sandbox.create).toHaveBeenCalled();
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      const envs = createCall?.[1]?.envs as Record<string, string> | undefined;

      expect(envs?.GH_TOKEN).toBe("user-provided-token");
    });

    it("should not inject connector secrets when compose does not reference them", async () => {
      vi.mocked(Sandbox.create).mockClear();

      // Create a GitHub connector
      await createTestConnector(user.scopeId, {
        accessToken: "ghp-should-not-appear",
      });

      // Create compose WITHOUT any GH_TOKEN reference
      const { composeId } = await createTestCompose(uniqueId("gh-no-ref"));

      const data = await createTestRun(composeId, "Test no GH_TOKEN ref");
      expect(data.status).toBe("running");

      // Verify GH_TOKEN is NOT in sandbox envs
      expect(Sandbox.create).toHaveBeenCalled();
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      const envs = createCall?.[1]?.envs as Record<string, string> | undefined;

      expect(envs?.GH_TOKEN).toBeUndefined();
      expect(envs?.GITHUB_TOKEN).toBeUndefined();
    });

    it("should work when no connectors are connected", async () => {
      // No connector setup - verify run still works
      const data = await createTestRun(
        testComposeId,
        "Test without connectors",
      );
      expect(data.status).toBe("running");
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
      expect(data.error.message).toMatch(/session/i);
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
      expect(data.error.message).toMatch(/session/i);
    });

    // Note: "Missing required secrets" validation is tested in the Validation
    // describe block above (lines 138-197).
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
      expect(data.error.message).toMatch(/checkpoint/i);
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
      expect(data.error.message).toMatch(/checkpoint/i);
    });

    it("should write session history to claude-code path format for claude-code framework", async () => {
      // Create and complete a run to get a checkpoint
      const { composeId } = await createTestCompose(
        `claude-code-resume-path-${Date.now()}`,
        { overrides: { framework: "claude-code" } },
      );

      const { runId: initialRunId } = await createTestRun(
        composeId,
        "Initial run",
      );
      const { checkpointId } = await completeTestRun(user.userId, initialRunId);

      // Clear mocks before resume run
      context.mocks.e2b.sandbox.files.write.mockClear();

      // Create a resume run using checkpointId
      await createTestRun(composeId, "Resume run", { checkpointId });

      // Find the session history write call (ends with .jsonl)
      const writeCalls = context.mocks.e2b.sandbox.files.write.mock.calls;
      const sessionHistoryCall = writeCalls.find((call) => {
        const path = call?.[0] as string;
        return path?.endsWith(".jsonl");
      });

      expect(sessionHistoryCall).toBeDefined();
      const writePath = sessionHistoryCall?.[0] as string;

      // Claude-code path format: /home/user/.claude/projects/-{workingDir}/session-id.jsonl
      expect(writePath).toMatch(/^\/home\/user\/\.claude\/projects\/-/);
      expect(writePath).toMatch(/\.jsonl$/);
    });

    // Note: "Missing required secrets" validation is tested in the Validation
    // describe block above.
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
                  image: "vm0/claude-code:latest",
                  framework: "claude-code",
                  working_dir: "/home/user/workspace",
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

    it("should reject request when volume has missing template variable with checkEnv", async () => {
      // Create compose with volume that uses a template variable
      const composeRequest = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: {
              version: "1.0",
              agents: {
                "test-agent": {
                  image: "vm0/claude-code:latest",
                  framework: "claude-code",
                  working_dir: "/home/user/workspace",
                  environment: { ANTHROPIC_API_KEY: "test-key" },
                  volumes: ["data:/mnt/data"],
                },
              },
              volumes: {
                data: {
                  name: "user-${{ vars.userId }}-storage",
                  version: "latest",
                },
              },
            },
          }),
        },
      );
      const composeResponse = await createComposeRoute(composeRequest);
      const compose = await composeResponse.json();

      // Create run WITHOUT providing required vars but WITH checkEnv: true
      // Vars validation only happens when checkEnv is enabled
      const runRequest = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: compose.composeId,
            prompt: "Test missing var",
            checkEnv: true,
          }),
        },
      );

      const response = await POST(runRequest);
      const data = await response.json();

      // API validates template variables when checkEnv is true
      expect(response.status).toBe(400);
      expect(data.error.message).toContain("userId");
    });

    it("should fail run when volume definition is missing", async () => {
      // Create compose with volume that references an undefined volume
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
                  image: "vm0/claude-code:latest",
                  framework: "claude-code",
                  working_dir: "/home/user/workspace",
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
      const request = createTestRequest("http://localhost:3000/api/variables", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
      });
      const response = await setVariableRoute(request);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to create variable: ${error.error?.message}`);
      }
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

      expect(data.status).toBe("running");
    });

    it("should use CLI vars over server-stored vars when both exist", async () => {
      vi.mocked(Sandbox.create).mockClear();

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

      expect(data.status).toBe("running");

      // Verify Sandbox.create was called with CLI value (not server value)
      expect(Sandbox.create).toHaveBeenCalled();
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      const envs = createCall?.[1]?.envs as Record<string, string> | undefined;

      expect(envs?.MY_VAR).toBe("cli-value");
    });

    it("should still fail when required var is neither on server nor CLI with checkEnv", async () => {
      // Create compose that requires a variable that doesn't exist
      const { composeId } = await createTestCompose(uniqueId("missing-var"), {
        overrides: {
          environment: {
            ANTHROPIC_API_KEY: "test-key",
            MISSING_VAR: "${{ vars.MISSING_VAR }}",
          },
        },
      });

      // Try to create run without providing the variable but WITH checkEnv: true
      // Vars validation only happens when checkEnv is enabled
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: composeId,
            prompt: "Test without var",
            checkEnv: true,
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("MISSING_VAR");
    });
  });

  describe("checkEnv flag behavior for vars", () => {
    it("should allow run with missing vars when checkEnv is not set (default)", async () => {
      // Create compose that requires vars
      const { composeId } = await createTestCompose(
        `vars-no-check-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              MY_VAR: "${{ vars.MY_VAR }}",
            },
          },
        },
      );

      // Create run WITHOUT providing vars and WITHOUT checkEnv
      // This should succeed because validation is opt-in
      const data = await createTestRun(composeId, "Test without vars");

      // Should succeed (running, not failed) - validation is skipped
      expect(data.status).toBe("running");
    });

    it("should reject run with missing vars when checkEnv is true", async () => {
      // Create compose that requires vars
      const { composeId } = await createTestCompose(
        `vars-check-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              MY_VAR: "${{ vars.MY_VAR }}",
            },
          },
        },
      );

      // Create run WITHOUT providing vars but WITH checkEnv: true
      const request = createTestRequest(
        "http://localhost:3000/api/agent/runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentComposeId: composeId,
            prompt: "Test with checkEnv",
            checkEnv: true,
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      // API validates template variables when checkEnv is true
      expect(response.status).toBe(400);
      expect(data.error.message).toMatch(
        /Missing required template variables/i,
      );
      expect(data.error.message).toContain("MY_VAR");
    });

    it("should succeed with checkEnv when all vars are provided", async () => {
      // Create compose that requires vars
      const { composeId } = await createTestCompose(
        `vars-check-ok-${Date.now()}`,
        {
          overrides: {
            environment: {
              ANTHROPIC_API_KEY: "test-key",
              MY_VAR: "${{ vars.MY_VAR }}",
            },
          },
        },
      );

      // Create run WITH vars AND checkEnv: true
      const data = await createTestRun(
        composeId,
        "Test with vars and checkEnv",
        {
          vars: { MY_VAR: "value" },
          checkEnv: true,
        },
      );

      expect(data.status).toBe("running");
    });
  });
});
