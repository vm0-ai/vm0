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
 *     context.setupMocks();  // Setup S3, Axiom mocks
 *     const user = await context.setupUser();
 *     // user.userId and user.orgId are unique to this test
 *     // No cleanup needed - data is isolated by unique IDs
 *   });
 */
import { vi, afterEach, type Mock, type MockInstance } from "vitest";
import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import { Axiom } from "@axiomhq/js";
import { mockClerk, clearClerkMock } from "./clerk-mock";
import { flushNextAsyncHooks } from "./next-after-hooks";
import { initServices } from "../lib/init-services";
import * as s3Client from "../lib/infra/s3/s3-client";
import * as axiomClient from "../lib/shared/axiom/client";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { connectors } from "@vm0/db/schema/connector";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userCache } from "@vm0/db/schema/user-cache";

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
    (
      bucket: string,
      key: string,
      data: Buffer,
      contentType?: string,
    ) => Promise<void>
  >;
  s3ObjectExists: MockInstance<
    (bucket: string, key: string) => Promise<boolean>
  >;
  verifyS3FilesExist: MockInstance<
    (bucket: string, s3Key: string, fileCount: number) => Promise<boolean>
  >;
  downloadBlob: MockInstance<(bucket: string, hash: string) => Promise<Buffer>>;
  downloadS3Buffer: MockInstance<
    (bucket: string, key: string) => Promise<Buffer>
  >;
  downloadManifest: MockInstance<
    (
      bucket: string,
      s3Key: string,
    ) => Promise<{
      version: string;
      createdAt: string;
      totalSize: number;
      fileCount: number;
      files: Array<{ path: string; hash: string; size: number }>;
    }>
  >;
  putS3Object: MockInstance<
    (
      bucket: string,
      key: string,
      body: string | Buffer,
      contentType: string,
    ) => Promise<void>
  >;
  deleteS3Objects: MockInstance<
    (bucket: string, keys: string[]) => Promise<void>
  >;
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
  /** Spy for ingestToAxiom function - use mockReturnValue to set return value */
  ingestToAxiom: MockInstance<typeof axiomClient.ingestToAxiom>;
  /** Spy for flushAxiom function */
  flushAxiom: MockInstance<typeof axiomClient.flushAxiom>;
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
 * Combined mock helpers for S3, Axiom, and Date
 */
interface MockHelpers {
  s3: S3Mocks;
  axiom: AxiomMocks;
  /** @deprecated Use context.mocks.date.setSystemTime() instead */
  dateNow: MockInstance<() => number>;
  /** Date mock for controlling new Date() and Date.now() */
  date: DateMocks;
  /** Execute all captured Next.js after() callbacks */
  flushAfter(): Promise<void>;
}

interface SetupUserOptions {
  /** Optional prefix for the user ID (default: "test-user") */
  prefix?: string;
}

interface TestContext {
  readonly signal: AbortSignal;
  readonly mocks: MockHelpers;
  readonly user: Promise<UserContext>;
  setupMocks(): MockHelpers;
  setupUser(options?: SetupUserOptions): Promise<UserContext>;
  createAgentCompose(
    vm0UserId: string,
    options?: { name?: string },
  ): Promise<{ id: string; name: string; orgId: string }>;
  createConnector(
    orgId: string,
    options: {
      userId: string;
      type?: string;
      authMethod?: string;
      oauthScopes?: readonly string[];
      tokenExpiresAt?: Date | null;
    },
  ): Promise<{ id: string; type: string }>;
}

export interface UserContext {
  readonly userId: string;
  readonly orgId: string;
}

/**
 * Insert a row into org_cache for testing cache behavior.
 */
export async function insertOrgCacheEntry(entry: {
  orgId: string;
  slug: string;
  name?: string;
  cachedAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId: entry.orgId,
      slug: entry.slug,
      name: entry.name ?? entry.slug,
      cachedAt: entry.cachedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        slug: entry.slug,
        name: entry.name ?? entry.slug,
        cachedAt: entry.cachedAt ?? new Date(),
      },
    });
}

/**
 * Ensure an org row exists in the `org` table.
 *
 * Creates an empty org_metadata row (credits=0 per column default, no
 * credit_expires_record). Tests that need a specific balance should call
 * setOrgCredits; tests that exercise the full starter-grant path should
 * go through the onboarding API or call ensureStarterCreditGrant directly.
 */
export async function ensureOrgRow(orgId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(orgMetadata)
    .values({ orgId })
    .onConflictDoNothing();
}

/**
 * Creates a test context that manages test lifecycle and mocks.
 * Call this once at the root scope of your describe block.
 *
 * The returned context provides:
 * - signal: AbortSignal for cleanup handlers
 * - mocks: Lazy getter for S3 and Axiom mocks
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
  const trackedUserIds: string[] = [];

  /**
   * Creates mock helpers (called by getter or setupMocks)
   * Only creates once per test, returns cached instance on subsequent calls
   */
  function createMocks(): MockHelpers {
    if (mockHelpers) return mockHelpers;

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
      downloadS3Buffer: vi
        .spyOn(s3Client, "downloadS3Buffer")
        .mockResolvedValue(Buffer.from("")),
      downloadManifest: vi
        .spyOn(s3Client, "downloadManifest")
        .mockResolvedValue({
          version: "0".repeat(64),
          createdAt: new Date().toISOString(),
          totalSize: 0,
          fileCount: 0,
          files: [],
        }),
      putS3Object: vi
        .spyOn(s3Client, "putS3Object")
        .mockResolvedValue(undefined),
      deleteS3Objects: vi
        .spyOn(s3Client, "deleteS3Objects")
        .mockResolvedValue(undefined),
    };

    // Axiom mocks - only set up if Axiom is mocked (vi.mock at module level in test file)
    const axiomMocks: AxiomMocks = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      ingest: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      queryAxiom: vi.spyOn(axiomClient, "queryAxiom").mockResolvedValue([]),
      ingestToAxiom: vi
        .spyOn(axiomClient, "ingestToAxiom")
        .mockReturnValue(true),
      flushAxiom: vi
        .spyOn(axiomClient, "flushAxiom")
        .mockResolvedValue(undefined),
    };
    // Use try/catch since Axiom may not be mocked in all test files
    try {
      const mocked = vi.mocked(Axiom);
      if (typeof mocked.mockImplementation === "function") {
        mocked.mockImplementation(() => {
          return axiomMocks as unknown as Axiom;
        });
      }
    } catch {
      // Axiom not mocked, skip
    }

    // Date.now mock - spy passes through to real implementation by default
    // Tests can override with: context.mocks.dateNow.mockReturnValue(specificTime)
    const dateNowMock = vi.spyOn(Date, "now");

    // Date constructor mock for controlling new Date()
    const RealDate = globalThis.Date;

    const dateMocks: DateMocks = {
      setSystemTime(date: Date) {
        // Also update dateNow mock for consistency
        dateNowMock.mockReturnValue(date.getTime());
        // Replace Date constructor with vi.stubGlobal (auto-restored by vitest)
        vi.stubGlobal(
          "Date",
          Object.assign(
            function MockDate(
              ...args: [] | ConstructorParameters<typeof RealDate>
            ) {
              if (args.length === 0) {
                return new RealDate(date.getTime());
              }
              return new RealDate(
                ...(args as ConstructorParameters<typeof RealDate>),
              );
            },
            {
              now: () => {
                return date.getTime();
              },
              parse: RealDate.parse.bind(RealDate),
              UTC: RealDate.UTC.bind(RealDate),
              prototype: RealDate.prototype,
            },
          ),
        );
      },
      useRealTime() {
        dateNowMock.mockRestore();
        vi.unstubAllGlobals();
      },
    };

    const helpers: MockHelpers = {
      s3: s3Mocks,
      axiom: axiomMocks,
      dateNow: dateNowMock,
      date: dateMocks,
      async flushAfter() {
        await flushNextAsyncHooks();
      },
    };
    mockHelpers = helpers;
    return helpers;
  }

  afterEach(async () => {
    // Clear Clerk mock and collect all userIds it was configured with.
    // These include both setupUser() IDs and hardcoded IDs from direct
    // mockClerk() calls in tests (e.g. "different-user-id" in email tests).
    const clerkUserIds = clearClerkMock();

    // Scope user_cache cleanup to IDs used in this test only, so parallel
    // test files don't wipe each other's cache entries (the original flaky bug).
    if (globalThis.services?.db) {
      const allIds = [...new Set([...trackedUserIds, ...clerkUserIds])];
      if (allIds.length > 0) {
        await globalThis.services.db
          .delete(userCache)
          .where(inArray(userCache.userId, allIds));
      }
    }

    // Abort the signal to trigger any cleanup handlers
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    controller.abort(error);

    // Create new controller for next test
    controller = new AbortController();

    // Restore any stubbed globals (e.g. Date from setSystemTime) so the
    // next test's beforeEach runs with the real clock.
    // Also restore the Date.now spy — vi.unstubAllGlobals only restores
    // the global Date constructor, leaving Date.now() stuck at the mocked
    // time. This breaks any code that runs in afterEach hooks (e.g.
    // flushNextAsyncHooks calling after()-queued triggerReasoning).
    if (mockHelpers) mockHelpers.dateNow.mockRestore();
    vi.unstubAllGlobals();

    // Reset mocks, cached user, and tracked IDs for next test
    mockHelpers = null;
    mockUser = null;
    trackedUserIds.length = 0;
  });

  /**
   * Creates an isolated user context for a single test.
   * Each call creates a unique user ID and org.
   *
   * Usage:
   *   const user = await context.setupUser();
   *   // user.userId is unique, e.g., "test-user-1706123456789-a1b2c3d4"
   *   // user.orgId is the created org's ID
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

      // Generate unique suffix shared between userId and org
      // This allows tests to derive org slug from userId if needed
      const suffix = uniqueSuffix();
      const userId = `${prefix}-${suffix}`;
      trackedUserIds.push(userId);

      // Mock Clerk for this user (orgId defaults to org_mock_${userId})
      mockClerk({ userId });

      // Pre-populate org_cache for the default Clerk org so that
      // getOrgNameAndSlug() works without hitting the Clerk API mock.
      // Use org-${suffix} as slug to match test conventions that derive
      // org slug from userId suffix.
      const defaultOrgId = `org_mock_${userId}`;
      const defaultOrgSlug = `org-${suffix}`;
      await insertOrgCacheEntry({ orgId: defaultOrgId, slug: defaultOrgSlug });
      await ensureOrgRow(defaultOrgId);
      controller.signal.throwIfAborted();

      return {
        userId,
        orgId: defaultOrgId,
      };
    })();

    // Only cache the default user
    if (prefix === "test-user") {
      mockUser = userPromise;
    }

    return await userPromise;
  }

  /**
   * Creates an agent compose for a user (without a binding).
   * Useful for testing link command which requires composes but no existing bindings.
   */
  async function createAgentCompose(
    vm0UserId: string,
    options: { name?: string } = {},
  ): Promise<{
    id: string;
    name: string;
    orgId: string;
  }> {
    const { name = uniqueId("test-compose") } = options;

    initServices();

    // Create org cache and compose for this user
    const orgSlug = uniqueId("org");
    const orgId = uniqueId("org");

    // Pre-populate org cache for getOrgNameAndSlug()
    await insertOrgCacheEntry({ orgId, slug: orgSlug });

    // Create a compose for this user
    const [compose] = await globalThis.services.db
      .insert(agentComposes)
      .values({
        userId: vm0UserId,
        orgId,
        name,
      })
      .returning();

    if (!compose) {
      throw new Error("Failed to create agent compose");
    }

    return {
      id: compose.id,
      name: compose.name,
      orgId,
    };
  }

  /**
   * Creates a connector record for an org.
   * Used to test connector-aware secret checks.
   */
  async function createConnector(
    orgId: string,
    options: {
      userId: string;
      type?: string;
      authMethod?: string;
      oauthScopes?: readonly string[];
      tokenExpiresAt?: Date | null;
    },
  ): Promise<{ id: string; type: string }> {
    const { userId, type = "github", authMethod = "oauth" } = options;

    initServices();

    const [connector] = await globalThis.services.db
      .insert(connectors)
      .values({
        userId,
        orgId,
        type,
        authMethod,
        oauthScopes: options.oauthScopes
          ? JSON.stringify([...options.oauthScopes])
          : undefined,
        tokenExpiresAt: options.tokenExpiresAt ?? undefined,
      })
      .returning();

    if (!connector) {
      throw new Error("Failed to create connector");
    }

    return { id: connector.id, type: connector.type };
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
    createAgentCompose,
    createConnector,
  };
}
