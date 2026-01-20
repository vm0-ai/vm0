/**
 * Integration tests for E2B Service database operations.
 *
 * This file complements e2b-service.test.ts by testing the database integration
 * aspects that are mocked in the unit tests. These tests verify that:
 * 1. Run status is correctly updated in the database after sandbox creation
 * 2. Sandbox IDs are properly persisted
 * 3. Database operations handle edge cases and errors appropriately
 *
 * Note: E2B SDK operations are mocked to isolate database testing.
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

// Mock the E2B SDK module
vi.mock("@e2b/code-interpreter");

// Mock e2bConfig to provide a default template
vi.mock("../config", () => ({
  e2bConfig: {
    defaultTimeout: 0,
    defaultTemplate: "mock-template",
  },
}));

// Mock StorageService
const mockStorageService = vi.hoisted(() => ({
  prepareStorageManifest: vi.fn().mockResolvedValue({
    storages: [],
    artifact: null,
  }),
}));

vi.mock("../../storage/storage-service", () => ({
  storageService: mockStorageService,
}));

// Mock image-service for resolveImageAlias
vi.mock("../../image/image-service", () => ({
  resolveImageAlias: vi
    .fn()
    .mockImplementation((_userId: string, alias: string) => {
      return Promise.resolve({
        templateName: alias,
        isUserImage: false,
      });
    }),
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

// Import e2bService after mocks are set up
let e2bService: typeof import("../e2b-service").e2bService;

// Test user ID and scope for isolation
const TEST_USER_ID = "test-user-e2b-db-integration";
const TEST_SCOPE_ID = randomUUID();
const TEST_COMPOSE_ID = randomUUID();
const TEST_VERSION_ID = "test-version-e2b-db-integration";

describe("E2B Service - Database Integration Tests", () => {
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
            image: "test-image",
            provider: "claude-code",
            working_dir: "/workspace",
          },
        },
      },
      createdBy: TEST_USER_ID,
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clean up test runs
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, TEST_USER_ID));

    // Reset mock implementations to defaults
    mockStorageService.prepareStorageManifest.mockResolvedValue({
      storages: [],
      artifact: null,
    });
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
   * Helper function to create a mock sandbox instance
   */
  const createMockSandbox = (sandboxId: string) => ({
    sandboxId,
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
  });

  describe("database status updates", () => {
    it("should persist sandbox ID after successful sandbox creation", async () => {
      // Arrange - Create a test run in the database
      const testRunId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Test prompt",
      });

      const mockSandbox = createMockSandbox("sandbox-123");
      vi.mocked(Sandbox.create).mockResolvedValue(
        mockSandbox as unknown as Sandbox,
      );

      const context: ExecutionContext = {
        runId: testRunId,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              image: "test-image",
              provider: "claude-code",
              working_dir: "/workspace",
            },
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Test prompt",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Verify result
      expect(result.status).toBe("running");
      expect(result.sandboxId).toBe("sandbox-123");

      // Verify database was updated with sandbox ID
      // Note: Status remains "pending" until webhook updates it to "running"
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      expect(run).toBeDefined();
      expect(run!.sandboxId).toBe("sandbox-123");
      // Status is NOT updated to "running" by e2bService - webhook does that
      expect(run!.status).toBe("pending");
    });

    it("should update run status to 'failed' when sandbox creation fails", async () => {
      // Arrange - Create a test run in the database
      const testRunId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Test prompt",
      });

      vi.mocked(Sandbox.create).mockRejectedValue(
        new Error("E2B API error: Invalid API key"),
      );

      const context: ExecutionContext = {
        runId: testRunId,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              image: "test-image",
              provider: "claude-code",
              working_dir: "/workspace",
            },
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Test prompt",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Verify result
      expect(result.status).toBe("failed");
      expect(result.error).toContain("E2B API error");

      // Verify database was updated with failed status
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      expect(run).toBeDefined();
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("E2B API error");
      expect(run!.completedAt).toBeInstanceOf(Date);
    });

    it("should persist sandbox ID for multiple concurrent executions", async () => {
      // Arrange - Create two test runs
      const testRunId1 = randomUUID();
      const testRunId2 = randomUUID();

      await globalThis.services.db.insert(agentRuns).values([
        {
          id: testRunId1,
          userId: TEST_USER_ID,
          agentComposeVersionId: TEST_VERSION_ID,
          status: "pending",
          prompt: "Test prompt 1",
        },
        {
          id: testRunId2,
          userId: TEST_USER_ID,
          agentComposeVersionId: TEST_VERSION_ID,
          status: "pending",
          prompt: "Test prompt 2",
        },
      ]);

      const mockSandbox1 = createMockSandbox("sandbox-001");
      const mockSandbox2 = createMockSandbox("sandbox-002");

      vi.mocked(Sandbox.create)
        .mockResolvedValueOnce(mockSandbox1 as unknown as Sandbox)
        .mockResolvedValueOnce(mockSandbox2 as unknown as Sandbox);

      const context1: ExecutionContext = {
        runId: testRunId1,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              image: "test-image",
              provider: "claude-code",
              working_dir: "/workspace",
            },
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Test prompt 1",
      };

      const context2: ExecutionContext = {
        runId: testRunId2,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              image: "test-image",
              provider: "claude-code",
              working_dir: "/workspace",
            },
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Test prompt 2",
      };

      // Act
      const [result1, result2] = await Promise.all([
        e2bService.execute(context1),
        e2bService.execute(context2),
      ]);

      // Assert - Verify results
      expect(result1.sandboxId).toBe("sandbox-001");
      expect(result2.sandboxId).toBe("sandbox-002");

      // Verify database has correct sandbox IDs for each run
      const runs = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.userId, TEST_USER_ID));

      expect(runs).toHaveLength(2);

      const run1 = runs.find((r) => r.id === testRunId1);
      const run2 = runs.find((r) => r.id === testRunId2);

      expect(run1!.sandboxId).toBe("sandbox-001");
      expect(run2!.sandboxId).toBe("sandbox-002");
    });
  });

  describe("database error handling", () => {
    it("should update run status to 'failed' when storage preparation fails", async () => {
      // Arrange - Create a test run in the database
      const testRunId = randomUUID();
      await globalThis.services.db.insert(agentRuns).values({
        id: testRunId,
        userId: TEST_USER_ID,
        agentComposeVersionId: TEST_VERSION_ID,
        status: "pending",
        prompt: "Test prompt",
      });

      // Mock storage service to throw error
      mockStorageService.prepareStorageManifest.mockRejectedValueOnce(
        new Error('Storage "claude-files" has no versions'),
      );

      const context: ExecutionContext = {
        runId: testRunId,
        agentComposeVersionId: TEST_VERSION_ID,
        agentCompose: {
          version: "1.0",
          agents: {
            "test-agent": {
              image: "test-image",
              provider: "claude-code",
              working_dir: "/workspace",
            },
          },
        },
        sandboxToken: "vm0_live_test_token",
        prompt: "Test prompt",
      };

      // Act
      const result = await e2bService.execute(context);

      // Assert - Verify result
      expect(result.status).toBe("failed");
      expect(result.error).toContain("claude-files");

      // Verify database was updated with failed status
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, testRunId));

      expect(run).toBeDefined();
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain("claude-files");
      expect(run!.completedAt).toBeInstanceOf(Date);
    });
  });
});
