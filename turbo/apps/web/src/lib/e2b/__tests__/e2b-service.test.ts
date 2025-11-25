/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Sandbox } from "@e2b/code-interpreter";
import { e2bService } from "../e2b-service";
import type { ExecutionContext } from "../../run/types";

// Mock the E2B SDK module
vi.mock("@e2b/code-interpreter");

// Mock e2bConfig to provide a default template
vi.mock("../config", () => ({
  e2bConfig: {
    defaultTimeout: 0,
    defaultTemplate: "mock-template",
  },
}));

// Mock VolumeService - use vi.hoisted to ensure mock is defined before vi.mock runs
const mockVolumeService = vi.hoisted(() => ({
  prepareVolumes: vi.fn().mockResolvedValue({
    preparedVolumes: [],
    tempDir: null,
    errors: [],
  }),
  prepareVolumesFromSnapshots: vi.fn().mockResolvedValue({
    preparedVolumes: [],
    tempDir: null,
    errors: [],
  }),
  mountVolumes: vi.fn().mockResolvedValue(undefined),
  cleanup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../volume/volume-service", () => ({
  volumeService: mockVolumeService,
}));

// Mock fs module
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi
        .fn()
        .mockResolvedValue(Buffer.from("#!/bin/bash\necho 'mock script'")),
    },
  };
});

describe("E2B Service - mocked unit tests", () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();

    // Reset mock implementations to defaults
    mockVolumeService.prepareVolumes.mockResolvedValue({
      preparedVolumes: [],
      tempDir: null,
      errors: [],
    });
    mockVolumeService.prepareVolumesFromSnapshots.mockResolvedValue({
      preparedVolumes: [],
      tempDir: null,
      errors: [],
    });
  });

  /**
   * Helper function to create a mock sandbox instance
   */
  const createMockSandbox = (overrides = {}) => ({
    sandboxId: "mock-sandbox-id-123",
    files: {
      write: vi.fn().mockResolvedValue(undefined),
    },
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

  describe("execute", () => {
    it("should create sandbox and execute Claude Code", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-001",
        agentConfigId: "test-agent-001",
        agentConfig: {},
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hello",
        dynamicVars: { testVar: "testValue" },
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Verify run result structure
      expect(result).toBeDefined();
      expect(result.runId).toBe(context.runId);

      // Verify sandbox was created
      expect(result.sandboxId).toBe("mock-sandbox-id-123");
      expect(Sandbox.create).toHaveBeenCalledTimes(1);

      // Verify execution status
      expect(result.status).toBe("completed");

      // Verify output is from Claude Code (not the old echo command)
      expect(result.output).not.toContain("Hello World from E2B!");
      expect(result.output).toBe("Mock Claude Code output");

      // Verify timing information
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.executionTimeMs).toBeLessThan(10000); // Should complete quickly with mocks

      // Verify timestamps
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);

      // Verify no error
      expect(result.error).toBeUndefined();

      // Verify sandbox methods were called
      // commands.run called: 1 (mkdir) + 6 (mv/chmod for each script) + 1 (execute) = 8 times
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(8);
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

      const context1: ExecutionContext = {
        runId: "run-test-002a",
        agentConfigId: "test-agent-002",
        agentConfig: {},
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hi",
      };

      const context2: ExecutionContext = {
        runId: "run-test-002b",
        agentConfigId: "test-agent-002",
        agentConfig: {},
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hi",
      };

      // Act
      const result1 = await e2bService.execute(context1);
      const result2 = await e2bService.execute(context2);

      // Assert
      expect(result1.runId).toBe(context1.runId);
      expect(result2.runId).toBe(context2.runId);
      expect(result1.sandboxId).not.toBe(result2.sandboxId);
      expect(result1.sandboxId).toBe("mock-sandbox-id-1");
      expect(result2.sandboxId).toBe("mock-sandbox-id-2");

      // Both should NOT contain old echo output
      expect(result1.output).not.toContain("Hello World from E2B!");
      expect(result2.output).not.toContain("Hello World from E2B!");

      // Verify both sandboxes were created and cleaned up
      expect(Sandbox.create).toHaveBeenCalledTimes(2);
      // Each sandbox: 1 (mkdir) + 6 (mv/chmod for each script) + 1 (execute) = 8 times
      expect(mockSandbox1.commands.run).toHaveBeenCalledTimes(8);
      expect(mockSandbox2.commands.run).toHaveBeenCalledTimes(8);
      expect(mockSandbox1.kill).toHaveBeenCalledTimes(1);
      expect(mockSandbox2.kill).toHaveBeenCalledTimes(1);
    });

    it("should handle execution with minimal options", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-003",
        agentConfigId: "test-agent-003",
        agentConfig: {},
        sandboxToken: "vm0_live_test_token",
        prompt: "What is 2+2?",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert
      expect(result.status).toBe("completed");
      expect(result.output).not.toContain("Hello World from E2B!");
      expect(result.output).toBeTruthy();

      // Verify sandbox was created and cleaned up
      expect(Sandbox.create).toHaveBeenCalledTimes(1);
      // 1 (mkdir) + 6 (mv/chmod for each script) + 1 (execute) = 8 times
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(8);
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });

    it("should include execution time metrics", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-004",
        agentConfigId: "test-agent-004",
        agentConfig: {},
        sandboxToken: "vm0_live_test_token",
        prompt: "Quick question: what is today?",
      };

      // Act
      const startTime = Date.now();
      const result = await e2bService.execute(context);
      const totalTime = Date.now() - startTime;

      // Assert - Execution time should be reasonable
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.executionTimeMs).toBeLessThanOrEqual(totalTime);

      // With mocks, execution should be fast
      expect(result.executionTimeMs).toBeLessThan(10000); // Under 10 seconds

      // Verify sandbox was created and cleaned up
      expect(Sandbox.create).toHaveBeenCalledTimes(1);
      // 1 (mkdir) + 6 (mv/chmod for each script) + 1 (execute) = 8 times
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(8);
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });

    it("should cleanup sandbox even on success", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-005",
        agentConfigId: "test-agent-005",
        agentConfig: {},
        sandboxToken: "vm0_live_test_token",
        prompt: "Say goodbye",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Sandbox should be created and cleaned up
      expect(result.sandboxId).toBe("mock-sandbox-id-123");
      expect(result.status).toBe("completed");
      expect(result.output).not.toContain("Hello World from E2B!");

      // Verify sandbox cleanup was called
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });

    it("should pass working_dir to sandbox when configured", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-006",
        agentConfigId: "test-agent-006",
        agentConfig: {
          version: "1.0",
          agent: {
            name: "test-agent",
            description: "Test agent with working dir",
            image: "test-image",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: [],
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Read files from workspace",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert
      expect(result.status).toBe("completed");

      // Verify sandbox command was called with environment variables including working_dir
      expect(mockSandbox.commands.run).toHaveBeenCalled();
      const commandCall = mockSandbox.commands.run.mock.calls.find(
        (call) => call[0] === "/usr/local/bin/vm0-agent/run-agent.sh",
      );
      expect(commandCall).toBeDefined();
      expect(commandCall?.[1]?.envs).toBeDefined();
      expect(commandCall?.[1]?.envs?.VM0_WORKING_DIR).toBe(
        "/home/user/workspace",
      );
    });

    it("should not set VM0_WORKING_DIR when not configured", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-007",
        agentConfigId: "test-agent-007",
        agentConfig: {
          version: "1.0",
          agent: {
            name: "test-agent",
            description: "Test agent without working dir",
            image: "test-image",
            provider: "claude-code",
            volumes: [],
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Read files",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert
      expect(result.status).toBe("completed");

      // Verify sandbox command was called without VM0_WORKING_DIR
      expect(mockSandbox.commands.run).toHaveBeenCalled();
      const commandCall = mockSandbox.commands.run.mock.calls.find(
        (call) => call[0] === "/usr/local/bin/vm0-agent/run-agent.sh",
      );
      expect(commandCall).toBeDefined();
      expect(commandCall?.[1]?.envs).toBeDefined();
      expect(commandCall?.[1]?.envs?.VM0_WORKING_DIR).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("should handle E2B API errors gracefully", async () => {
      // Arrange
      vi.mocked(Sandbox.create).mockRejectedValue(
        new Error("E2B API error: Invalid API key"),
      );

      const context: ExecutionContext = {
        runId: "run-test-error",
        agentConfigId: "test-agent-error",
        agentConfig: {},
        sandboxToken: "vm0_live_test_token",
        prompt: "This should fail due to mocked error",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Should return failed status instead of throwing
      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("E2B API error");
      expect(result.sandboxId).toBe("unknown");

      // Verify Sandbox.create was called but sandbox methods were not
      expect(Sandbox.create).toHaveBeenCalledTimes(1);
    });

    it("should fail when volume preparation returns errors", async () => {
      // Arrange - Mock volume service to return errors
      mockVolumeService.prepareVolumes.mockResolvedValueOnce({
        preparedVolumes: [],
        tempDir: null,
        errors: [
          'claude-system: Volume "claude-files" has no versions',
          "data: S3 download failed",
        ],
      });

      const context: ExecutionContext = {
        runId: "run-test-volume-error",
        agentConfigId: "test-agent-volume-error",
        agentConfig: {},
        sandboxToken: "vm0_live_test_token",
        prompt: "This should fail due to volume errors",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Should return failed status with volume errors
      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Volume preparation failed");
      expect(result.error).toContain("claude-files");
      expect(result.error).toContain("S3 download failed");
      expect(result.sandboxId).toBe("unknown");

      // Verify sandbox was never created since volume prep failed
      expect(Sandbox.create).not.toHaveBeenCalled();

      // Verify cleanup was still called
      expect(mockVolumeService.cleanup).toHaveBeenCalled();
    });
  });

  describe("template selection", () => {
    it("should use agent.image when provided", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-template-001",
        agentConfigId: "test-agent-template-001",
        agentConfig: {
          version: "1.0",
          agent: {
            name: "test-agent",
            description: "Test agent with custom image",
            image: "custom-template-name",
            provider: "claude-code",
            working_dir: "/workspace",
            volumes: [],
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Test with custom image",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert
      expect(result.status).toBe("completed");
      expect(Sandbox.create).toHaveBeenCalledTimes(1);

      // Verify that agent.image was used
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      expect(createCall?.[0]).toBe("custom-template-name");
    });
  });
});
