/**
 * Test Helper Utilities for Isolated Test Contexts
 *
 * This module provides utilities for creating isolated test environments
 * where each test has its own user context, eliminating the need for
 * cleanup between tests.
 *
 * Usage:
 *   const context = testContext();
 *
 *   test("my test", async () => {
 *     const { mocks } = context;  // Lazy initialization
 *     const user = await setupUser();
 *     // user.userId and user.scopeId are unique to this test
 *     // No cleanup needed - data is isolated by unique IDs
 *   });
 */
import { vi, afterEach, type Mock, type MockInstance } from "vitest";
import { randomUUID } from "crypto";
import { Sandbox } from "@e2b/code-interpreter";
import { mockClerk, clearClerkMock } from "./clerk-mock";
import { initServices } from "../lib/init-services";
import { createTestScope } from "./api-test-helpers";
import * as s3Client from "../lib/s3/s3-client";

/**
 * E2B Sandbox mock structure
 */
interface E2bMocks {
  sandbox: {
    sandboxId: string;
    getHostname: Mock;
    files: { write: Mock };
    commands: { run: Mock };
    kill: Mock;
  };
}

/**
 * S3 client mock structure
 */
interface S3Mocks {
  generatePresignedUrl: MockInstance<
    (
      bucket: string,
      key: string,
      expiresIn?: number,
      filename?: string,
    ) => Promise<string>
  >;
  listS3Objects: MockInstance<
    (bucket: string, prefix: string) => Promise<{ key: string; size: number }[]>
  >;
  uploadS3Buffer: MockInstance<
    (bucket: string, key: string, data: Buffer) => Promise<void>
  >;
}

/**
 * Combined mock helpers for E2B and S3
 */
interface MockHelpers {
  e2b: E2bMocks;
  s3: S3Mocks;
}

interface TestContext {
  readonly signal: AbortSignal;
  readonly mocks: MockHelpers;
  setupMocks(): MockHelpers;
}

export interface UserContext {
  readonly userId: string;
  readonly scopeId: string;
}

interface SetupUserOptions {
  /** Optional prefix for the user ID (default: "test-user") */
  prefix?: string;
}

/**
 * Creates a test context that manages test lifecycle and mocks.
 * Call this once at the root scope of your describe block.
 *
 * The returned context provides:
 * - signal: AbortSignal for cleanup handlers
 * - mocks: Lazy getter for E2B and S3 mocks
 * - setupMocks(): Explicit setup method (same effect as mocks getter)
 *
 * Usage:
 *   describe("my tests", () => {
 *     const context = testContext();
 *
 *     test("test 1", async () => {
 *       const { mocks } = context;  // Lazy initialization
 *       const user = await setupUser();
 *       // Customize mocks if needed:
 *       // mocks.e2b.sandbox.files.write.mockRejectedValue(new Error('fail'));
 *     });
 *   });
 */
export function testContext(): TestContext {
  let controller = new AbortController();
  let mockHelpers: MockHelpers | null = null;

  /**
   * Creates mock helpers (called by getter or setupMocks)
   * Only creates once per test, returns cached instance on subsequent calls
   */
  function createMocks(): MockHelpers {
    if (mockHelpers) return mockHelpers;

    // E2B sandbox mock
    const mockSandbox = {
      sandboxId: "test-sandbox-123",
      getHostname: vi.fn().mockReturnValue("test-sandbox.e2b.dev"),
      files: {
        write: vi.fn().mockResolvedValue(undefined),
      },
      commands: {
        run: vi.fn().mockResolvedValue({
          stdout: "Mock output",
          stderr: "",
          exitCode: 0,
        }),
      },
      kill: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Sandbox.create).mockResolvedValue(
      mockSandbox as unknown as Sandbox,
    );
    vi.mocked(Sandbox.connect).mockResolvedValue(
      mockSandbox as unknown as Sandbox,
    );

    // S3 mocks
    const s3Mocks: S3Mocks = {
      generatePresignedUrl: vi
        .spyOn(s3Client, "generatePresignedUrl")
        .mockResolvedValue("https://mock-presigned-url"),
      listS3Objects: vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]),
      uploadS3Buffer: vi
        .spyOn(s3Client, "uploadS3Buffer")
        .mockResolvedValue(undefined),
    };

    const helpers: MockHelpers = {
      e2b: { sandbox: mockSandbox },
      s3: s3Mocks,
    };
    mockHelpers = helpers;
    return helpers;
  }

  afterEach(() => {
    // Clear Clerk mock
    clearClerkMock();

    // Abort the signal to trigger any cleanup handlers
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    controller.abort(error);

    // Create new controller for next test
    controller = new AbortController();

    // Reset mocks for next test
    mockHelpers = null;
  });

  return {
    get signal(): AbortSignal {
      return controller.signal;
    },
    get mocks(): MockHelpers {
      return createMocks();
    },
    setupMocks(): MockHelpers {
      return createMocks();
    },
  };
}

/**
 * Creates an isolated user context for a single test.
 * Each call creates a unique user ID and scope.
 *
 * Usage:
 *   const user = await setupUser();
 *   // user.userId is unique, e.g., "test-user-1706123456789-a1b2c3d4"
 *   // user.scopeId is the created scope's ID
 *
 * The Clerk mock is automatically configured for this user.
 */
export async function setupUser({
  prefix = "test-user",
}: SetupUserOptions = {}): Promise<UserContext> {
  initServices();

  // Generate unique user ID
  const uniqueSuffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userId = `${prefix}-${uniqueSuffix}`;

  // Mock Clerk for this user
  mockClerk({ userId });

  // Create scope via API
  const scopeData = await createTestScope(`scope-${uniqueSuffix}`);

  return {
    userId,
    scopeId: scopeData.id,
  };
}
