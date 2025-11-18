/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from "vitest";
import { e2bService } from "../e2b-service";
import type { CreateRuntimeOptions } from "../types";

describe("E2B Service - unit tests with real E2B API", () => {
  beforeAll(() => {
    // Verify E2B_API_KEY is available
    if (!process.env.E2B_API_KEY) {
      throw new Error(
        "E2B_API_KEY is required for E2B service tests. Please set it in .env.local",
      );
    }
  });

  describe("createRuntime", () => {
    it("should create sandbox and execute hello world command", async () => {
      const runtimeId = "rt-test-001";
      const options: CreateRuntimeOptions = {
        agentConfigId: "test-agent-001",
        prompt: "test prompt",
        dynamicVars: { testVar: "testValue" },
      };

      const result = await e2bService.createRuntime(runtimeId, options);

      // Verify runtime result structure
      expect(result).toBeDefined();
      expect(result.runtimeId).toBe(runtimeId);

      // Verify sandbox was created
      expect(result.sandboxId).toBeDefined();
      expect(result.sandboxId).toBeTruthy();

      // Verify execution status
      expect(result.status).toBe("completed");

      // Verify output contains expected hello world message
      expect(result.output).toContain("Hello World from E2B!");

      // Verify timing information
      expect(result.executionTimeMs).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeLessThan(60000); // Should complete in under 60s

      // Verify timestamps
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);

      // Verify no error
      expect(result.error).toBeUndefined();
    }, 60000); // 60 second timeout for real E2B API

    it("should use provided runtime IDs for multiple calls", async () => {
      const options: CreateRuntimeOptions = {
        agentConfigId: "test-agent-002",
        prompt: "test prompt",
      };

      const runtimeId1 = "rt-test-002a";
      const runtimeId2 = "rt-test-002b";

      const result1 = await e2bService.createRuntime(runtimeId1, options);
      const result2 = await e2bService.createRuntime(runtimeId2, options);

      expect(result1.runtimeId).toBe(runtimeId1);
      expect(result2.runtimeId).toBe(runtimeId2);
      expect(result1.sandboxId).not.toBe(result2.sandboxId);
    }, 120000); // 120 second timeout for two sequential calls

    it("should handle execution with minimal options", async () => {
      const runtimeId = "rt-test-003";
      const options: CreateRuntimeOptions = {
        agentConfigId: "test-agent-003",
        prompt: "minimal test",
      };

      const result = await e2bService.createRuntime(runtimeId, options);

      expect(result.status).toBe("completed");
      expect(result.output).toContain("Hello World from E2B!");
    }, 60000);

    it("should include execution time metrics", async () => {
      const runtimeId = "rt-test-004";
      const options: CreateRuntimeOptions = {
        agentConfigId: "test-agent-004",
        prompt: "performance test",
      };

      const startTime = Date.now();
      const result = await e2bService.createRuntime(runtimeId, options);
      const totalTime = Date.now() - startTime;

      // Execution time should be reasonable
      expect(result.executionTimeMs).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeLessThanOrEqual(totalTime);

      // E2B sandbox creation typically takes 1-10 seconds
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(100);
      expect(result.executionTimeMs).toBeLessThan(30000);
    }, 60000);

    it("should cleanup sandbox even on success", async () => {
      const runtimeId = "rt-test-005";
      const options: CreateRuntimeOptions = {
        agentConfigId: "test-agent-005",
        prompt: "cleanup test",
      };

      const result = await e2bService.createRuntime(runtimeId, options);

      // Sandbox should be created and cleaned up
      expect(result.sandboxId).toBeDefined();
      expect(result.status).toBe("completed");

      // Note: We cannot directly verify the sandbox was killed,
      // but the service logs should show cleanup messages
    }, 60000);
  });

  describe("error handling", () => {
    it("should handle E2B API errors gracefully", async () => {
      // Save original API key
      const originalKey = process.env.E2B_API_KEY;

      try {
        // Temporarily set invalid API key to trigger error
        process.env.E2B_API_KEY = "invalid-key-123";

        const runtimeId = "rt-test-error";
        const options: CreateRuntimeOptions = {
          agentConfigId: "test-agent-error",
          prompt: "error test",
        };

        const result = await e2bService.createRuntime(runtimeId, options);

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
