/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Sandbox } from "@e2b/code-interpreter";
import { e2bService } from "../e2b-service";
import { sendVm0StartEvent } from "../../events";
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

// Mock StorageService - use vi.hoisted to ensure mock is defined before vi.mock runs
const mockStorageService = vi.hoisted(() => ({
  prepareStorageManifest: vi.fn().mockResolvedValue({
    storages: [],
    artifact: null,
  }),
}));

vi.mock("../../storage/storage-service", () => ({
  storageService: mockStorageService,
}));

// Mock events module
vi.mock("../../events", () => ({
  sendVm0StartEvent: vi.fn().mockResolvedValue(undefined),
  sendVm0ErrorEvent: vi.fn().mockResolvedValue(undefined),
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

// Mock database update function
const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});

describe("E2B Service - mocked unit tests", () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();

    // Reset mock implementations to defaults
    mockStorageService.prepareStorageManifest.mockResolvedValue({
      storages: [],
      artifact: null,
    });

    // Mock globalThis.services.db for sandboxId persistence
    globalThis.services = {
      db: {
        update: mockDbUpdate,
      },
    } as unknown as typeof globalThis.services;
  });

  /**
   * Helper function to create a valid agent compose with working_dir
   */
  const createValidAgentCompose = (overrides = {}) => ({
    version: "1.0",
    agents: {
      "test-agent": {
        image: "test-image",
        provider: "claude-code",
        working_dir: "/workspace",
        ...overrides,
      },
    },
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
    it("should create sandbox and start agent execution (fire-and-forget)", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-001",
        agentComposeVersionId: "test-version-001",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hello",
        templateVars: { testVar: "testValue" },
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Verify run result structure
      expect(result).toBeDefined();
      expect(result.runId).toBe(context.runId);

      // Verify sandbox was created
      expect(result.sandboxId).toBe("mock-sandbox-id-123");
      expect(Sandbox.create).toHaveBeenCalledTimes(1);

      // Verify execution status is "running" (fire-and-forget)
      expect(result.status).toBe("running");

      // Output is empty since script runs in background
      expect(result.output).toBe("");

      // Verify timing information (prep time only)
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.executionTimeMs).toBeLessThan(10000); // Should complete quickly with mocks

      // Verify timestamps - only createdAt, no completedAt (still running)
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeUndefined();

      // Verify no error
      expect(result.error).toBeUndefined();

      // Verify sandbox methods were called
      // Optimized: commands.run called only 2 times:
      // 1. tar extract (mkdir + tar xf + chmod in single command)
      // 2. execute with background:true
      // Note: All 10 scripts uploaded via single tar archive
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(2);
      // Sandbox is NOT killed - it continues running (fire-and-forget)
      expect(mockSandbox.kill).not.toHaveBeenCalled();

      // Verify sandboxId was persisted to database immediately after creation
      expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    });

    it("should persist sandboxId to database before starting agent execution", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      // Track call order to verify sandboxId is persisted BEFORE agent execution starts
      const callOrder: string[] = [];
      mockDbUpdate.mockImplementation(() => {
        callOrder.push("db.update");
        return {
          set: vi.fn().mockImplementation(() => {
            return {
              where: vi.fn().mockResolvedValue(undefined),
            };
          }),
        };
      });
      mockSandbox.commands.run.mockImplementation(() => {
        callOrder.push("commands.run");
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      });

      const context: ExecutionContext = {
        runId: "run-test-order",
        agentComposeVersionId: "test-version-order",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Test call order",
      };

      // Act
      await e2bService.execute(context);

      // Assert - db.update should happen BEFORE the second commands.run (agent execution)
      // Call order should be: commands.run (tar extract), db.update, commands.run (agent execution)
      const dbUpdateIndex = callOrder.indexOf("db.update");
      const agentExecutionIndex = callOrder.lastIndexOf("commands.run");
      expect(dbUpdateIndex).toBeLessThan(agentExecutionIndex);
    });

    it("should send vm0_start event with correct parameters", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-event",
        agentComposeVersionId: "test-version-event",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Test prompt",
        templateVars: { key: "value" },
        agentName: "My Agent",
        resumedFromCheckpointId: "checkpoint-123",
        continuedFromSessionId: undefined,
      };

      // Act
      await e2bService.execute(context);

      // Assert - Verify vm0_start event was sent with correct parameters
      expect(sendVm0StartEvent).toHaveBeenCalledTimes(1);
      expect(sendVm0StartEvent).toHaveBeenCalledWith({
        runId: "run-test-event",
        agentComposeVersionId: "test-version-event",
        agentName: "My Agent",
        prompt: "Test prompt",
        templateVars: { key: "value" },
        resumedFromCheckpointId: "checkpoint-123",
        continuedFromSessionId: undefined,
        artifact: undefined,
        volumes: undefined,
      });
    });

    it("should include artifact and volumes in vm0_start event when prepared", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      // Mock storage service to return manifest with artifact and volumes
      mockStorageService.prepareStorageManifest.mockResolvedValueOnce({
        storages: [
          {
            name: "data-volume",
            mountPath: "/data",
            vasStorageName: "data-storage",
            vasVersionId: "vol-version-abc",
            files: [],
          },
          {
            name: "models",
            mountPath: "/models",
            vasStorageName: "models-storage",
            vasVersionId: "vol-version-xyz",
            files: [],
          },
        ],
        artifact: {
          mountPath: "/workspace",
          vasStorageName: "my-artifact",
          vasVersionId: "art-version-123",
          files: [],
        },
      });

      const context: ExecutionContext = {
        runId: "run-test-storages",
        agentComposeVersionId: "test-version-storages",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Test with storages",
      };

      // Act
      await e2bService.execute(context);

      // Assert - Verify vm0_start event includes artifact and volumes
      expect(sendVm0StartEvent).toHaveBeenCalledTimes(1);
      expect(sendVm0StartEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-test-storages",
          artifact: { "my-artifact": "art-version-123" },
          volumes: {
            "data-volume": "vol-version-abc",
            models: "vol-version-xyz",
          },
        }),
      );
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
        agentComposeVersionId: "test-version-002",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hi",
      };

      const context2: ExecutionContext = {
        runId: "run-test-002b",
        agentComposeVersionId: "test-version-002",
        agentCompose: createValidAgentCompose(),
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

      // Both return "running" status (fire-and-forget)
      expect(result1.status).toBe("running");
      expect(result2.status).toBe("running");

      // Verify both sandboxes were created (but NOT cleaned up - fire-and-forget)
      expect(Sandbox.create).toHaveBeenCalledTimes(2);
      // Optimized: Each sandbox only 2 commands.run calls (tar extract + execute)
      expect(mockSandbox1.commands.run).toHaveBeenCalledTimes(2);
      expect(mockSandbox2.commands.run).toHaveBeenCalledTimes(2);
      // Sandboxes NOT killed - they continue running
      expect(mockSandbox1.kill).not.toHaveBeenCalled();
      expect(mockSandbox2.kill).not.toHaveBeenCalled();
    });

    it("should handle execution with minimal options", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-003",
        agentComposeVersionId: "test-version-003",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "What is 2+2?",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - fire-and-forget returns "running"
      expect(result.status).toBe("running");
      expect(result.output).toBe(""); // Empty - script runs in background

      // Verify sandbox was created (but NOT cleaned up - fire-and-forget)
      expect(Sandbox.create).toHaveBeenCalledTimes(1);
      // Optimized: 2 commands.run calls (tar extract + execute)
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(2);
      expect(mockSandbox.kill).not.toHaveBeenCalled();
    });

    it("should include execution time metrics", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-004",
        agentComposeVersionId: "test-version-004",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Quick question: what is today?",
      };

      // Act
      const startTime = Date.now();
      const result = await e2bService.execute(context);
      const totalTime = Date.now() - startTime;

      // Assert - Execution time should be reasonable (prep time only)
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.executionTimeMs).toBeLessThanOrEqual(totalTime);

      // With mocks, prep should be fast
      expect(result.executionTimeMs).toBeLessThan(10000); // Under 10 seconds

      // Verify sandbox was created (but NOT cleaned up - fire-and-forget)
      expect(Sandbox.create).toHaveBeenCalledTimes(1);
      // Optimized: 2 commands.run calls (tar extract + execute)
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(2);
      expect(mockSandbox.kill).not.toHaveBeenCalled();
    });

    it("should NOT cleanup sandbox on success (fire-and-forget)", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-005",
        agentComposeVersionId: "test-version-005",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Say goodbye",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Sandbox should be created but NOT cleaned up (fire-and-forget)
      expect(result.sandboxId).toBe("mock-sandbox-id-123");
      expect(result.status).toBe("running");

      // Verify sandbox cleanup was NOT called (fire-and-forget)
      expect(mockSandbox.kill).not.toHaveBeenCalled();
    });

    it("should pass working_dir to sandbox when configured", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-006",
        agentComposeVersionId: "test-version-006",
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              description: "Test agent with working dir",
              image: "test-image",
              provider: "claude-code",
              working_dir: "/home/user/workspace",
            },
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Read files from workspace",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - fire-and-forget returns "running"
      expect(result.status).toBe("running");

      // Verify sandbox was created with environment variables including working_dir
      // NOTE: VM0_WORKING_DIR is passed at sandbox creation time, not via commands.run({ envs })
      // because E2B's background mode doesn't pass envs to the background process
      expect(Sandbox.create).toHaveBeenCalled();
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      expect(createCall?.[1]?.envs?.VM0_WORKING_DIR).toBe(
        "/home/user/workspace",
      );
    });

    it("should fail when working_dir is not configured", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: "run-test-007",
        agentComposeVersionId: "test-version-007",
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              description: "Test agent without working dir",
              image: "test-image",
              provider: "claude-code",
              working_dir: "",
            },
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Read files",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - should fail because working_dir is required
      expect(result.status).toBe("failed");
      expect(result.error).toContain("working_dir");
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
        agentComposeVersionId: "test-version-error",
        agentCompose: createValidAgentCompose(),
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

    it("should fail when storage manifest preparation throws error", async () => {
      // Arrange - Mock storage service to throw error
      mockStorageService.prepareStorageManifest.mockRejectedValueOnce(
        new Error('Storage "claude-files" has no versions'),
      );

      const context: ExecutionContext = {
        runId: "run-test-storage-error",
        agentComposeVersionId: "test-version-storage-error",
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "This should fail due to storage errors",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Should return failed status with storage errors
      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("claude-files");
      expect(result.sandboxId).toBe("unknown");

      // Verify sandbox was never created since storage prep failed
      expect(Sandbox.create).not.toHaveBeenCalled();
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
        agentComposeVersionId: "test-version-template-001",
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              description: "Test agent with custom image",
              image: "custom-template-name",
              provider: "claude-code",
              working_dir: "/workspace",
            },
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Test with custom image",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - fire-and-forget returns "running"
      expect(result.status).toBe("running");
      expect(Sandbox.create).toHaveBeenCalledTimes(1);

      // Verify that agent.image was used
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      expect(createCall?.[0]).toBe("custom-template-name");
    });
  });

  describe("killSandbox", () => {
    it("should connect to sandbox and kill it", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.connect).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      // Act
      await e2bService.killSandbox("test-sandbox-id-123");

      // Assert
      expect(Sandbox.connect).toHaveBeenCalledTimes(1);
      expect(Sandbox.connect).toHaveBeenCalledWith("test-sandbox-id-123");
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });

    it("should handle errors gracefully when sandbox connect fails", async () => {
      // Arrange
      vi.mocked(Sandbox.connect).mockRejectedValue(
        new Error("Sandbox not found"),
      );

      // Act - should not throw
      await expect(
        e2bService.killSandbox("non-existent-sandbox"),
      ).resolves.not.toThrow();

      // Assert
      expect(Sandbox.connect).toHaveBeenCalledTimes(1);
    });

    it("should handle errors gracefully when sandbox kill fails", async () => {
      // Arrange
      const mockSandbox = createMockSandbox({
        kill: vi.fn().mockRejectedValue(new Error("Kill failed")),
      });
      vi.mocked(Sandbox.connect).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      // Act - should not throw
      await expect(
        e2bService.killSandbox("test-sandbox-id"),
      ).resolves.not.toThrow();

      // Assert
      expect(Sandbox.connect).toHaveBeenCalledTimes(1);
      expect(mockSandbox.kill).toHaveBeenCalledTimes(1);
    });
  });
});
