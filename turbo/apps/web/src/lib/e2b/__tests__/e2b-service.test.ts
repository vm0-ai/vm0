/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Sandbox } from "@e2b/code-interpreter";
import { e2bService } from "../e2b-service";
import type { CreateRunOptions } from "../types";

// Mock the E2B SDK module
vi.mock("@e2b/code-interpreter");

describe("E2B Service - mocked unit tests", () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  /**
   * Helper function to create a mock sandbox instance
   */
  const createMockSandbox = (overrides = {}) => ({
    sandboxId: "mock-sandbox-id-123",
    commands: {
      run: vi.fn().mockResolvedValue({
        stdout: "Mock Claude Code output",
        stderr: "",
        exitCode: 0,
      }),
    },
    kill: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  describe("createRun", () => {
    it("should create sandbox and execute Claude Code", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const runId = "run-test-001";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-001",
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hello",
        dynamicVars: { testVar: "testValue" },
      };

      // Act
      const result = await e2bService.createRun(runId, options);

      // Assert - Verify run result structure
      expect(result).toBeDefined();
      expect(result.runId).toBe(runId);

      // Verify sandbox was created
      expect(result.sandboxId).toBe("mock-sandbox-id-123");
      expect(Sandbox.create).toHaveBeenCalledTimes(1);

      // Verify execution status
      expect(result.status).toBe("completed");

      // Verify output is from Claude Code (not the old echo command)
      expect(result.output).not.toContain("Hello World from E2B!");
      expect(result.output).toBe("Mock Claude Code output");

      // Verify timing information
      expect(result.executionTimeMs).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeLessThan(10000); // Should complete quickly with mocks

      // Verify timestamps
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);

      // Verify no error
      expect(result.error).toBeUndefined();

      // Verify sandbox methods were called
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(1);
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });

    it("should use provided run IDs for multiple calls", async () => {
      // Arrange
      const mockSandbox1 = createMockSandbox({
        sandboxId: "mock-sandbox-id-1",
      });
      const mockSandbox2 = createMockSandbox({
        sandboxId: "mock-sandbox-id-2",
      });

      vi.mocked(Sandbox.create)
        .mockResolvedValueOnce(mockSandbox1 as unknown as Sandbox)
        .mockResolvedValueOnce(mockSandbox2 as unknown as Sandbox);

      const options: CreateRunOptions = {
        agentConfigId: "test-agent-002",
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hi",
      };

      const runId1 = "run-test-002a";
      const runId2 = "run-test-002b";

      // Act
      const result1 = await e2bService.createRun(runId1, options);
      const result2 = await e2bService.createRun(runId2, options);

      // Assert
      expect(result1.runId).toBe(runId1);
      expect(result2.runId).toBe(runId2);
      expect(result1.sandboxId).not.toBe(result2.sandboxId);
      expect(result1.sandboxId).toBe("mock-sandbox-id-1");
      expect(result2.sandboxId).toBe("mock-sandbox-id-2");

      // Both should NOT contain old echo output
      expect(result1.output).not.toContain("Hello World from E2B!");
      expect(result2.output).not.toContain("Hello World from E2B!");

      // Verify both sandboxes were created and cleaned up
      expect(Sandbox.create).toHaveBeenCalledTimes(2);
      expect(mockSandbox1.commands.run).toHaveBeenCalledTimes(1);
      expect(mockSandbox2.commands.run).toHaveBeenCalledTimes(1);
      expect(mockSandbox1.kill).toHaveBeenCalledTimes(1);
      expect(mockSandbox2.kill).toHaveBeenCalledTimes(1);
    });

    it("should handle execution with minimal options", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const runId = "run-test-003";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-003",
        sandboxToken: "vm0_live_test_token",
        prompt: "What is 2+2?",
      };

      // Act
      const result = await e2bService.createRun(runId, options);

      // Assert
      expect(result.status).toBe("completed");
      expect(result.output).not.toContain("Hello World from E2B!");
      expect(result.output).toBeTruthy();

      // Verify sandbox was created and cleaned up
      expect(Sandbox.create).toHaveBeenCalledTimes(1);
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(1);
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });

    it("should include execution time metrics", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const runId = "run-test-004";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-004",
        sandboxToken: "vm0_live_test_token",
        prompt: "Quick question: what is today?",
      };

      // Act
      const startTime = Date.now();
      const result = await e2bService.createRun(runId, options);
      const totalTime = Date.now() - startTime;

      // Assert - Execution time should be reasonable
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.executionTimeMs).toBeLessThanOrEqual(totalTime);

      // With mocks, execution should be fast
      expect(result.executionTimeMs).toBeLessThan(10000); // Under 10 seconds

      // Verify sandbox was created and cleaned up
      expect(Sandbox.create).toHaveBeenCalledTimes(1);
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(1);
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });

    it("should cleanup sandbox even on success", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const runId = "run-test-005";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-005",
        sandboxToken: "vm0_live_test_token",
        prompt: "Say goodbye",
      };

      // Act
      const result = await e2bService.createRun(runId, options);

      // Assert - Sandbox should be created and cleaned up
      expect(result.sandboxId).toBe("mock-sandbox-id-123");
      expect(result.status).toBe("completed");
      expect(result.output).not.toContain("Hello World from E2B!");

      // Verify sandbox cleanup was called
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe("error handling", () => {
    it("should handle E2B API errors gracefully", async () => {
      // Arrange
      vi.mocked(Sandbox.create).mockRejectedValue(
        new Error("E2B API error: Invalid API key"),
      );

      const runId = "run-test-error";
      const options: CreateRunOptions = {
        agentConfigId: "test-agent-error",
        sandboxToken: "vm0_live_test_token",
        prompt: "This should fail due to mocked error",
      };

      // Act
      const result = await e2bService.createRun(runId, options);

      // Assert - Should return failed status instead of throwing
      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("E2B API error");
      expect(result.sandboxId).toBe("unknown");

      // Verify Sandbox.create was called but sandbox methods were not
      expect(Sandbox.create).toHaveBeenCalledTimes(1);
    });
  });
});
