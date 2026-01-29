import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { randomUUID } from "crypto";
import { Sandbox } from "@e2b/code-interpreter";
import {
  createTestRequest,
  createTestCompose,
  createTestCliToken,
  deleteTestCliToken,
  createTestModelProvider,
  createTestRun,
  getTestRun,
  completeTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/agent/runs - Internal Runs API", () => {
  let user: UserContext;
  let testComposeId: string;

  beforeEach(async () => {
    // Setup mocks (E2B, S3, Axiom)
    context.setupMocks();

    // Create unique user for this test
    user = await context.setupUser();

    // Create test compose
    const { composeId } = await createTestCompose(`agent-${Date.now()}`);
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

      try {
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
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should allow unlimited runs when limit is 0", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "0");

      try {
        const run1 = await createTestRun(testComposeId, "Run 1");
        const run2 = await createTestRun(testComposeId, "Run 2");
        const run3 = await createTestRun(testComposeId, "Run 3");

        expect(run1.status).toBe("running");
        expect(run2.status).toBe("running");
        expect(run3.status).toBe("running");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should only count pending and running statuses", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "1");

      try {
        // Create and complete first run
        const run1 = await createTestRun(testComposeId, "First run");
        expect(run1.status).toBe("running");
        await completeTestRun(user.userId, run1.runId);

        // Second run should succeed since first is completed
        const run2 = await createTestRun(testComposeId, "Second run");
        expect(run2.status).toBe("running");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should respect higher limit values", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "3");

      try {
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
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("should fall back to default limit when CONCURRENT_RUN_LIMIT is invalid", async () => {
      vi.stubEnv("CONCURRENT_RUN_LIMIT", "invalid");

      try {
        // First run should succeed (default limit is 1)
        const run1 = await createTestRun(testComposeId, "First run");
        expect(run1.status).toBe("running");

        // Second run should fail with 429 (default limit of 1)
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
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("Model Provider Injection", () => {
    it("should succeed when model provider is configured and no API key in compose", async () => {
      // Create model provider
      await createTestModelProvider("anthropic-api-key", "test-api-key");

      // Create compose without API key
      const { composeId } = await createTestCompose(`mp-agent-${Date.now()}`, {
        skipDefaultApiKey: true,
      });

      const data = await createTestRun(composeId, "Test with model provider");

      expect(data.status).toBe("running");
    });

    it("should fail run when no model provider and no API key in compose", async () => {
      // Create compose without API key and no environment block
      const { composeId } = await createTestCompose(`no-mp-${Date.now()}`, {
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
      const { composeId } = await createTestCompose(`mp-select-${Date.now()}`, {
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
      const { composeId } = await createTestCompose(`codex-${Date.now()}`, {
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
      const { composeId } = await createTestCompose(`foundry-${Date.now()}`, {
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
      const { composeId } = await createTestCompose(
        `invalid-mp-${Date.now()}`,
        {
          skipDefaultApiKey: true,
        },
      );

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
  });
});
