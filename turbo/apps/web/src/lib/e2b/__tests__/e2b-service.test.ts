/**
 * E2B Service Integration Tests
 *
 * Mock Strategy (Only External Services):
 * - MOCK: E2B SDK (external API), S3 client (Cloudflare R2)
 * - REAL: Database, storage service, image service
 *
 * vitest runs as a single process with access to real database and services.
 * We test the full integration of E2B service with real internal services
 * while isolating external API calls.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { Sandbox } from "@e2b/code-interpreter";
import { initServices } from "../../init-services";
import { agentRuns } from "../../../db/schema/agent-run";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../db/schema/agent-compose";
import { scopes } from "../../../db/schema/scope";
import { randomUUID } from "crypto";
import type { ExecutionContext } from "../../run/types";
import * as s3Client from "../../s3/s3-client";

// Mock third-party SDKs only (E2B, AWS)
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

// Override default env vars with test-specific values
vi.hoisted(() => {
  vi.stubEnv("E2B_TEMPLATE_NAME", "mock-template");
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

// Import e2bService after mocks are set up
let e2bService: typeof import("../e2b-service").e2bService;

// Test user ID and scope for isolation
const TEST_USER_ID = "test-user-e2b-service";
const TEST_SCOPE_ID = randomUUID();
const TEST_COMPOSE_ID = randomUUID();
const TEST_VERSION_ID = "test-version-e2b-service";

describe("E2B Service", () => {
  beforeAll(async () => {
    initServices();
    const e2bModule = await import("../e2b-service");
    e2bService = e2bModule.e2bService;

    // Create test scope (required for compose creation)
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, TEST_SCOPE_ID));
    await globalThis.services.db.insert(scopes).values({
      id: TEST_SCOPE_ID,
      slug: `test-e2b-${TEST_SCOPE_ID.slice(0, 8)}`,
      type: "personal",
      ownerId: TEST_USER_ID,
    });

    // Create test compose and version (required for runs)
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, TEST_COMPOSE_ID));
    await globalThis.services.db.insert(agentComposes).values({
      id: TEST_COMPOSE_ID,
      userId: TEST_USER_ID,
      scopeId: TEST_SCOPE_ID,
      name: "test-compose-e2b",
      headVersionId: TEST_VERSION_ID,
    });

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, TEST_VERSION_ID));
    await globalThis.services.db.insert(agentComposeVersions).values({
      id: TEST_VERSION_ID,
      composeId: TEST_COMPOSE_ID,
      content: {
        version: "1.0",
        agents: {
          "test-agent": {
            image: "vm0/claude-code",
            framework: "claude-code",
            working_dir: "/workspace",
          },
        },
      },
      createdBy: TEST_USER_ID,
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock s3Client functions (spying on real module)
    vi.spyOn(s3Client, "generatePresignedUrl").mockResolvedValue(
      "https://mock-presigned-url",
    );
    vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]);
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);

    // Clean up test runs
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, TEST_USER_ID));
  });

  afterAll(async () => {
    // Final cleanup
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, TEST_USER_ID));

    await globalThis.services.db
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, TEST_VERSION_ID));

    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, TEST_COMPOSE_ID));

    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, TEST_SCOPE_ID));
  });

  /**
   * Helper function to create a valid agent compose with working_dir
   */
  const createValidAgentCompose = (overrides = {}) => ({
    version: "1.0",
    agents: {
      "test-agent": {
        image: "vm0/claude-code",
        framework: "claude-code",
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

      const runId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Say hello",
      });

      const context: ExecutionContext = {
        runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hello",
        vars: { testVar: "testValue" },
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
      expect(mockSandbox.commands.run).toHaveBeenCalledTimes(2);
      // Sandbox is NOT killed - it continues running (fire-and-forget)
      expect(mockSandbox.kill).not.toHaveBeenCalled();

      // Verify database was updated with sandboxId
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId));
      expect(run?.sandboxId).toBe("mock-sandbox-id-123");
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

      const runId1 = randomUUID();
      const runId2 = randomUUID();

      await globalThis.services.db.insert(agentRuns).values([
        {
          id: runId1,
          userId: TEST_USER_ID,
          agentComposeVersionId: TEST_VERSION_ID,
          status: "pending",
          prompt: "Say hi",
        },
        {
          id: runId2,
          userId: TEST_USER_ID,
          agentComposeVersionId: TEST_VERSION_ID,
          status: "pending",
          prompt: "Say hi",
        },
      ]);

      const context1: ExecutionContext = {
        runId: runId1,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: createValidAgentCompose(),
        sandboxToken: "vm0_live_test_token",
        prompt: "Say hi",
      };

      const context2: ExecutionContext = {
        runId: runId2,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
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

      const runId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "What is 2+2?",
      });

      const context: ExecutionContext = {
        runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
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

      const runId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Quick question: what is today?",
      });

      const context: ExecutionContext = {
        runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
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

      const runId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Say goodbye",
      });

      const context: ExecutionContext = {
        runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
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

      const runId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Read files from workspace",
      });

      const context: ExecutionContext = {
        runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              description: "Test agent with working dir",
              image: "vm0/claude-code",
              framework: "claude-code",
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

      const runId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Read files",
      });

      const context: ExecutionContext = {
        runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              description: "Test agent without working dir",
              image: "vm0/claude-code",
              framework: "claude-code",
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

      const runId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "This should fail due to mocked error",
      });

      const context: ExecutionContext = {
        runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
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

      // Verify database was updated
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId));
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("E2B API error");
    });
  });

  describe("template selection", () => {
    it("should use agent.image when provided", async () => {
      // Arrange
      const mockSandbox = createMockSandbox();
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const runId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Test with custom image",
      });

      const context: ExecutionContext = {
        runId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              description: "Test agent with custom image",
              image: "vm0/codex",
              framework: "claude-code",
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

      // Verify that agent.image was resolved and used
      const createCall = vi.mocked(Sandbox.create).mock.calls[0];
      expect(createCall).toBeDefined();
      // The resolved E2B template name should be passed
      expect(createCall?.[0]).toBeDefined();
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
