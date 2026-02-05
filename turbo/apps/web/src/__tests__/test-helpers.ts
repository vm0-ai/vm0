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
 *     context.setupMocks();  // Setup E2B, S3, Axiom mocks
 *     const user = await context.setupUser();
 *     // user.userId and user.scopeId are unique to this test
 *     // No cleanup needed - data is isolated by unique IDs
 *   });
 */
import { vi, afterEach, type Mock, type MockInstance } from "vitest";
import { randomUUID } from "crypto";

/**
 * Generate a unique 8-character suffix for test isolation.
 * Internal helper used by uniqueId and other helpers.
 * @returns An 8-character random suffix
 */
function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Generate a unique ID with a prefix for test isolation.
 * @param prefix - The prefix for the ID (e.g., "test-user", "test-sandbox")
 * @returns A unique ID in the format `${prefix}-${8-char-uuid}`
 */
export function uniqueId(prefix: string): string {
  return `${prefix}-${uniqueSuffix()}`;
}
import { eq } from "drizzle-orm";
import { Sandbox } from "@e2b/code-interpreter";
import { Axiom } from "@axiomhq/js";
import { mockClerk, clearClerkMock } from "./clerk-mock";
import { initServices } from "../lib/init-services";
import { createTestScope } from "./api-test-helpers";
import * as s3Client from "../lib/s3/s3-client";
import * as axiomClient from "../lib/axiom/client";
import { slackInstallations } from "../db/schema/slack-installation";
import { slackUserLinks } from "../db/schema/slack-user-link";
import { slackBindings } from "../db/schema/slack-binding";
import { agentComposes } from "../db/schema/agent-compose";
import { scopes } from "../db/schema/scope";
import { encryptCredentialValue } from "../lib/crypto/secrets-encryption";
import { env } from "../env";

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
  generatePresignedPutUrl: MockInstance<
    (
      bucket: string,
      key: string,
      contentType?: string,
      expiresIn?: number,
    ) => Promise<string>
  >;
  listS3Objects: MockInstance<
    (bucket: string, prefix: string) => Promise<{ key: string; size: number }[]>
  >;
  uploadS3Buffer: MockInstance<
    (bucket: string, key: string, data: Buffer) => Promise<void>
  >;
  s3ObjectExists: MockInstance<
    (bucket: string, key: string) => Promise<boolean>
  >;
  verifyS3FilesExist: MockInstance<
    (bucket: string, s3Key: string, fileCount: number) => Promise<boolean>
  >;
  downloadBlob: MockInstance<(bucket: string, hash: string) => Promise<Buffer>>;
}

/**
 * Axiom client mock structure
 */
interface AxiomMocks {
  query: Mock;
  ingest: Mock;
  flush: Mock;
  /** Spy for queryAxiom function - use mockResolvedValue to set return value */
  queryAxiom: MockInstance<typeof axiomClient.queryAxiom>;
  /** Spy for ingestToAxiom function - use mockResolvedValue to set return value */
  ingestToAxiom: MockInstance<typeof axiomClient.ingestToAxiom>;
}

/**
 * Date mock structure for controlling time in tests
 */
interface DateMocks {
  /** Set a fixed system time for new Date() and Date.now() */
  setSystemTime(date: Date): void;
  /** Restore real time behavior */
  useRealTime(): void;
}

/**
 * Combined mock helpers for E2B, S3, Axiom, and Date
 */
interface MockHelpers {
  e2b: E2bMocks;
  s3: S3Mocks;
  axiom: AxiomMocks;
  /** @deprecated Use context.mocks.date.setSystemTime() instead */
  dateNow: MockInstance<() => number>;
  /** Date mock for controlling new Date() and Date.now() */
  date: DateMocks;
}

interface SetupUserOptions {
  /** Optional prefix for the user ID (default: "test-user") */
  prefix?: string;
}

interface SlackInstallationOptions {
  /** Whether to also create a user link (default: false) */
  withUserLink?: boolean;
  /** Slack workspace ID (default: "T123") */
  workspaceId?: string;
  /** Slack user ID for user link (default: "U123") */
  slackUserId?: string;
}

interface SlackInstallationResult {
  installation: {
    id: string;
    slackWorkspaceId: string;
    botUserId: string;
  };
  userLink: {
    id: string;
    slackUserId: string;
    slackWorkspaceId: string;
    vm0UserId: string;
  };
}

interface SlackBindingOptions {
  agentName?: string;
  description?: string | null;
  enabled?: boolean;
}

interface TestContext {
  readonly signal: AbortSignal;
  readonly mocks: MockHelpers;
  readonly user: Promise<UserContext>;
  setupMocks(): MockHelpers;
  setupUser(options?: SetupUserOptions): Promise<UserContext>;
  createSlackInstallation(
    options?: SlackInstallationOptions,
  ): Promise<SlackInstallationResult>;
  createSlackBinding(
    userLinkId: string,
    options?: SlackBindingOptions,
  ): Promise<{ id: string; agentName: string; composeId: string }>;
  createAgentCompose(
    vm0UserId: string,
    options?: { name?: string },
  ): Promise<{ id: string; name: string; scopeId: string }>;
}

export interface UserContext {
  readonly userId: string;
  readonly scopeId: string;
}

/**
 * Creates a test context that manages test lifecycle and mocks.
 * Call this once at the root scope of your describe block.
 *
 * The returned context provides:
 * - signal: AbortSignal for cleanup handlers
 * - mocks: Lazy getter for E2B and S3 mocks
 * - setupMocks(): Explicit setup method (same effect as mocks getter)
 * - setupUser(): Create isolated user context for the test
 *
 * Usage:
 *   describe("my tests", () => {
 *     const context = testContext();
 *
 *     test("test 1", async () => {
 *       context.setupMocks();
 *       const user = await context.setupUser();
 *       // Customize mocks if needed:
 *       // context.mocks.e2b.sandbox.files.write.mockRejectedValue(new Error('fail'));
 *     });
 *   });
 */
export function testContext(): TestContext {
  let controller = new AbortController();
  let mockHelpers: MockHelpers | null = null;
  let mockUser: Promise<UserContext> | null = null;

  /**
   * Creates mock helpers (called by getter or setupMocks)
   * Only creates once per test, returns cached instance on subsequent calls
   */
  function createMocks(): MockHelpers {
    if (mockHelpers) return mockHelpers;

    // E2B sandbox mock - use unique sandboxId per test to avoid state pollution
    const mockSandbox = {
      sandboxId: uniqueId("test-sandbox"),
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

    // S3 mocks with in-memory blob storage for testing session history
    // Tracks blob uploads so downloads can return the correct content
    const blobStorage = new Map<string, Buffer>();

    const uploadS3BufferMock = vi
      .spyOn(s3Client, "uploadS3Buffer")
      .mockImplementation(
        async (_bucket: string, key: string, data: Buffer) => {
          // Store blob data for later retrieval in tests
          blobStorage.set(key, data);
        },
      );

    const downloadBlobMock = vi
      .spyOn(s3Client, "downloadBlob")
      .mockImplementation(async (_bucket: string, hash: string) => {
        // Look up blob data that was previously uploaded
        const key = `blobs/${hash}.blob`;
        const data = blobStorage.get(key);
        if (data) {
          return data;
        }
        // Fallback: return standard test session history content
        // This handles cases where the blob exists in DB (deduplication)
        // but was uploaded in a different test instance
        return Buffer.from(JSON.stringify([{ role: "user", content: "test" }]));
      });

    const s3Mocks: S3Mocks = {
      generatePresignedUrl: vi
        .spyOn(s3Client, "generatePresignedUrl")
        .mockResolvedValue("https://mock-presigned-url"),
      generatePresignedPutUrl: vi
        .spyOn(s3Client, "generatePresignedPutUrl")
        .mockResolvedValue("https://mock-presigned-put-url"),
      listS3Objects: vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]),
      uploadS3Buffer: uploadS3BufferMock,
      s3ObjectExists: vi
        .spyOn(s3Client, "s3ObjectExists")
        .mockResolvedValue(true),
      verifyS3FilesExist: vi
        .spyOn(s3Client, "verifyS3FilesExist")
        .mockResolvedValue(true),
      downloadBlob: downloadBlobMock,
    };

    // Axiom mocks - only set up if Axiom is mocked (vi.mock at module level in test file)
    const axiomMocks: AxiomMocks = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      ingest: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      queryAxiom: vi
        .spyOn(axiomClient, "queryAxiom")
        .mockResolvedValue([]) as MockInstance<typeof axiomClient.queryAxiom>,
      ingestToAxiom: vi
        .spyOn(axiomClient, "ingestToAxiom")
        .mockResolvedValue(true) as MockInstance<
        typeof axiomClient.ingestToAxiom
      >,
    };
    // Use try/catch since Axiom may not be mocked in all test files
    try {
      const mocked = vi.mocked(Axiom);
      if (typeof mocked.mockImplementation === "function") {
        mocked.mockImplementation(() => axiomMocks as unknown as Axiom);
      }
    } catch {
      // Axiom not mocked, skip
    }

    // Date.now mock - default implementation returns real time
    // Tests can override with: context.mocks.dateNow.mockReturnValue(specificTime)
    const originalDateNow = Date.now.bind(Date);
    const dateNowMock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => originalDateNow());

    // Date constructor mock for controlling new Date()
    const RealDate = globalThis.Date;

    const dateMocks: DateMocks = {
      setSystemTime(date: Date) {
        // Also update dateNow mock for consistency
        dateNowMock.mockReturnValue(date.getTime());
        // Replace Date constructor with vi.stubGlobal (auto-restored by vitest)
        vi.stubGlobal(
          "Date",
          // eslint-disable-next-line no-restricted-syntax -- legacy code
          class extends RealDate {
            constructor(...args: unknown[]) {
              if (args.length === 0) {
                super(date.getTime());
              } else {
                // @ts-expect-error - calling super with variable args
                super(...args);
              }
            }

            static now() {
              return date.getTime();
            }
          },
        );
      },
      useRealTime() {
        dateNowMock.mockImplementation(() => originalDateNow());
        vi.unstubAllGlobals();
      },
    };

    const helpers: MockHelpers = {
      e2b: { sandbox: mockSandbox },
      s3: s3Mocks,
      axiom: axiomMocks,
      dateNow: dateNowMock,
      date: dateMocks,
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

    // Reset mocks and cached user for next test
    mockHelpers = null;
    mockUser = null;
  });

  /**
   * Creates an isolated user context for a single test.
   * Each call creates a unique user ID and scope.
   *
   * Usage:
   *   const user = await context.setupUser();
   *   // user.userId is unique, e.g., "test-user-1706123456789-a1b2c3d4"
   *   // user.scopeId is the created scope's ID
   *
   * The Clerk mock is automatically configured for this user.
   */
  async function setupUser({
    prefix = "test-user",
  }: SetupUserOptions = {}): Promise<UserContext> {
    // Only cache when using default prefix to support creating multiple users
    // with different prefixes in the same test (e.g., for cross-user security tests)
    if (mockUser && prefix === "test-user") {
      return mockUser;
    }

    const userPromise = (async () => {
      initServices();

      // Generate unique suffix shared between userId and scope
      // This allows tests to derive scope slug from userId if needed
      const suffix = uniqueSuffix();
      const userId = `${prefix}-${suffix}`;

      // Mock Clerk for this user
      mockClerk({ userId });

      // Create scope via API (uses same suffix for derivability)
      const scopeData = await createTestScope(`scope-${suffix}`);
      controller.signal.throwIfAborted();

      return {
        userId,
        scopeId: scopeData.id,
      };
    })();

    // Only cache the default user
    if (prefix === "test-user") {
      mockUser = userPromise;
    }

    return await userPromise;
  }

  /**
   * Creates a Slack installation for testing slash commands and events.
   * Optionally creates a user link as well.
   */
  async function createSlackInstallation(
    options: SlackInstallationOptions = {},
  ): Promise<SlackInstallationResult> {
    // Generate unique workspace ID per test to avoid constraint violations
    const suffix = uniqueSuffix();
    const {
      withUserLink = false,
      workspaceId = `T${suffix}`,
      slackUserId = `U${suffix}`,
    } = options;

    initServices();

    const { SECRETS_ENCRYPTION_KEY } = env();

    // Create installation
    const encryptedBotToken = encryptCredentialValue(
      "xoxb-test-bot-token",
      SECRETS_ENCRYPTION_KEY,
    );

    const [installation] = await globalThis.services.db
      .insert(slackInstallations)
      .values({
        slackWorkspaceId: workspaceId,
        slackWorkspaceName: "Test Workspace",
        encryptedBotToken,
        botUserId: "B123",
        installedBySlackUserId: slackUserId,
      })
      .returning();

    if (!installation) {
      throw new Error("Failed to create Slack installation");
    }

    let userLink = {
      id: "",
      slackUserId: "",
      slackWorkspaceId: "",
      vm0UserId: "",
    };

    if (withUserLink) {
      const vm0UserId = uniqueId("test-user");

      const [createdLink] = await globalThis.services.db
        .insert(slackUserLinks)
        .values({
          slackUserId,
          slackWorkspaceId: workspaceId,
          vm0UserId,
        })
        .returning();

      if (createdLink) {
        userLink = createdLink;
      }
    }

    return {
      installation: {
        id: installation.id,
        slackWorkspaceId: installation.slackWorkspaceId,
        botUserId: installation.botUserId,
      },
      userLink,
    };
  }

  /**
   * Creates a Slack binding (agent) for a user link.
   * Creates a compose first if needed.
   */
  async function createSlackBinding(
    userLinkId: string,
    options: SlackBindingOptions = {},
  ): Promise<{ id: string; agentName: string; composeId: string }> {
    const {
      agentName = uniqueId("test-agent"),
      description = null,
      enabled = true,
    } = options;

    initServices();

    // Get user link to find the vm0UserId
    const [link] = await globalThis.services.db
      .select()
      .from(slackUserLinks)
      .where(eq(slackUserLinks.id, userLinkId))
      .limit(1);

    if (!link) {
      throw new Error(`Slack user link not found: ${userLinkId}`);
    }

    // Create a scope directly in the database (bypass API to avoid Clerk auth)
    const scopeSlug = uniqueId("scope");
    const [scopeData] = await globalThis.services.db
      .insert(scopes)
      .values({
        slug: scopeSlug,
        type: "personal",
        ownerId: link.vm0UserId,
      })
      .returning();

    if (!scopeData) {
      throw new Error("Failed to create scope");
    }

    // Create a compose for this binding
    const [compose] = await globalThis.services.db
      .insert(agentComposes)
      .values({
        userId: link.vm0UserId,
        scopeId: scopeData.id,
        name: `compose-${agentName}`,
      })
      .returning();

    if (!compose) {
      throw new Error("Failed to create agent compose");
    }

    const [binding] = await globalThis.services.db
      .insert(slackBindings)
      .values({
        slackUserLinkId: userLinkId,
        vm0UserId: link.vm0UserId,
        slackWorkspaceId: link.slackWorkspaceId,
        composeId: compose.id,
        agentName,
        description,
        enabled,
      })
      .returning();

    if (!binding) {
      throw new Error("Failed to create Slack binding");
    }

    return {
      id: binding.id,
      agentName: binding.agentName,
      composeId: compose.id,
    };
  }

  /**
   * Creates an agent compose for a user (without a binding).
   * Useful for testing link command which requires composes but no existing bindings.
   */
  async function createAgentCompose(
    vm0UserId: string,
    options: { name?: string } = {},
  ): Promise<{ id: string; name: string; scopeId: string }> {
    const { name = uniqueId("test-compose") } = options;

    initServices();

    // Create a scope directly in the database (bypass API to avoid Clerk auth)
    const scopeSlug = uniqueId("scope");
    const [scopeData] = await globalThis.services.db
      .insert(scopes)
      .values({
        slug: scopeSlug,
        type: "personal",
        ownerId: vm0UserId,
      })
      .returning();

    if (!scopeData) {
      throw new Error("Failed to create scope");
    }

    // Create a compose for this user
    const [compose] = await globalThis.services.db
      .insert(agentComposes)
      .values({
        userId: vm0UserId,
        scopeId: scopeData.id,
        name,
      })
      .returning();

    if (!compose) {
      throw new Error("Failed to create agent compose");
    }

    return {
      id: compose.id,
      name: compose.name,
      scopeId: scopeData.id,
    };
  }

  return {
    get signal(): AbortSignal {
      return controller.signal;
    },
    get mocks(): MockHelpers {
      return createMocks();
    },
    get user(): Promise<UserContext> {
      return setupUser();
    },
    setupMocks(): MockHelpers {
      return createMocks();
    },
    setupUser,
    createSlackInstallation,
    createSlackBinding,
    createAgentCompose,
  };
}
