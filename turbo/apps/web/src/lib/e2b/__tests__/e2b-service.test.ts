/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from "vitest";
import { e2bService } from "../e2b-service";
import type { CreateRunOptions } from "../types";

describe("E2B Service - unit tests with real E2B API", () => {
  beforeAll(() => {
    // Verify E2B_API_KEY is available
    if (!process.env.E2B_API_KEY) {
      throw new Error(
        "E2B_API_KEY is required for E2B service tests. Please set it in .env.local",
      );
    }
  });

  describe("createRun", () => {
    it("should create sandbox and execute Claude Code", async () => {
      const runId = "run-test-001";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-001",
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hello",
        dynamicVars: { testVar: "testValue" },
      };

      const result = await e2bService.createRun(runId, options);

      // Verify run result structure
      expect(result).toBeDefined();
      expect(result.runId).toBe(runId);

      // Verify sandbox was created
      expect(result.sandboxId).toBeDefined();
      expect(result.sandboxId).toBeTruthy();

      // Verify execution status
      expect(result.status).toBe("completed");

      // Verify output is from Claude Code, NOT the old echo command
      expect(result.output).not.toContain("Hello World from E2B!");
      expect(result.output).toBeTruthy(); // Should have some output

      // Verify timing information
      expect(result.executionTimeMs).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeLessThan(600000); // Should complete in under 10 minutes

      // Verify timestamps
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);

      // Verify no error
      expect(result.error).toBeUndefined();
    }, 600000); // 10 minute timeout for Claude Code execution

    it("should use provided run IDs for multiple calls", async () => {
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-002",
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hi",
      };

      const runId1 = "run-test-002a";
      const runId2 = "run-test-002b";

      const result1 = await e2bService.createRun(runId1, options);
      const result2 = await e2bService.createRun(runId2, options);

      expect(result1.runId).toBe(runId1);
      expect(result2.runId).toBe(runId2);
      expect(result1.sandboxId).not.toBe(result2.sandboxId);
      // Both should NOT contain old echo output
      expect(result1.output).not.toContain("Hello World from E2B!");
      expect(result2.output).not.toContain("Hello World from E2B!");
    }, 1200000); // 20 minute timeout for two sequential calls

    it("should handle execution with minimal options", async () => {
      const runId = "run-test-003";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-003",
        sandboxToken: "vm0_live_test_token",
        prompt: "What is 2+2?",
      };

      const result = await e2bService.createRun(runId, options);

      expect(result.status).toBe("completed");
      expect(result.output).not.toContain("Hello World from E2B!");
      expect(result.output).toBeTruthy();
    }, 600000);

    it("should include execution time metrics", async () => {
      const runId = "run-test-004";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-004",
        sandboxToken: "vm0_live_test_token",
        prompt: "Quick question: what is today?",
      };

      const startTime = Date.now();
      const result = await e2bService.createRun(runId, options);
      const totalTime = Date.now() - startTime;

      // Execution time should be reasonable
      expect(result.executionTimeMs).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeLessThanOrEqual(totalTime);

      // Claude Code execution + E2B sandbox creation
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(100);
      expect(result.executionTimeMs).toBeLessThan(600000); // Under 10 minutes
    }, 600000);

    it("should cleanup sandbox even on success", async () => {
      const runId = "run-test-005";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-005",
        sandboxToken: "vm0_live_test_token",
        prompt: "Say goodbye",
      };

      const result = await e2bService.createRun(runId, options);

      // Sandbox should be created and cleaned up
      expect(result.sandboxId).toBeDefined();
      expect(result.status).toBe("completed");
      expect(result.output).not.toContain("Hello World from E2B!");

      // Note: We cannot directly verify the sandbox was killed,
      // but the service logs should show cleanup messages
    }, 600000);
  });

  describe("error handling", () => {
    it("should handle E2B API errors gracefully", async () => {
      // Save original API key
      const originalKey = process.env.E2B_API_KEY;

      try {
        // Temporarily set invalid API key to trigger error
        process.env.E2B_API_KEY = "invalid-key-123";

        const runId = "run-test-error";
        const options: CreateRunOptions = {
          agentConfigId: "test-agent-error",
          sandboxToken: "vm0_live_test_token",
          prompt: "This should fail due to invalid API key",
        };

        const result = await e2bService.createRun(runId, options);

        // Should return failed status instead of throwing
        expect(result.status).toBe("failed");
        expect(result.error).toBeDefined();
        expect(result.sandboxId).toBe("unknown");
      } finally {
        // Restore original API key
        process.env.E2B_API_KEY = originalKey;
      }
    }, 60000);
  });
});
