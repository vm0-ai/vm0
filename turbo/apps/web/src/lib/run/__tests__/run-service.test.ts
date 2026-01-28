import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { eq } from "drizzle-orm";
import { initServices } from "../../init-services";
import {
  agentComposeVersions,
  agentComposes,
} from "../../../db/schema/agent-compose";
import { agentRuns } from "../../../db/schema/agent-run";
import { conversations } from "../../../db/schema/conversation";
import { checkpoints } from "../../../db/schema/checkpoint";
import { scopes } from "../../../db/schema/scope";
import { credentials } from "../../../db/schema/credential";
import { modelProviders } from "../../../db/schema/model-provider";
import { randomUUID } from "crypto";
import { encryptCredentialValue } from "../../crypto";

// Mock e2b-service to prevent env() access during module load
vi.mock("../../e2b", () => ({
  e2bService: {
    execute: vi.fn(),
  },
}));

// Mock agent-session service to isolate unit tests from database dependencies.
// The agent-session service manages CLI agent sessions and conversations, which
// requires database access. Mocking it allows testing RunService methods that
// depend on session lookups without requiring actual session records in the database.
// The relative path "../../agent-session" is resolved by vitest relative to this test file.
vi.mock("../../agent-session", () => ({
  agentSessionService: {
    getByIdWithConversation: vi.fn(),
  },
}));

// Import after mocks
let calculateSessionHistoryPath: typeof import("../run-service").calculateSessionHistoryPath;
let RunService: typeof import("../run-service").RunService;
let NotFoundError: typeof import("../../errors").NotFoundError;
let UnauthorizedError: typeof import("../../errors").UnauthorizedError;
let BadRequestError: typeof import("../../errors").BadRequestError;
let ConcurrentRunLimitError: typeof import("../../errors").ConcurrentRunLimitError;
let agentSessionService: typeof import("../../agent-session").agentSessionService;

// Test user ID and scope for isolation
const TEST_USER_ID = "test-user-run-service";
const TEST_SCOPE_ID = randomUUID();

describe("run-service", () => {
  beforeAll(async () => {
    initServices();
    const runServiceModule = await import("../run-service");
    calculateSessionHistoryPath = runServiceModule.calculateSessionHistoryPath;
    RunService = runServiceModule.RunService;

    const errorsModule = await import("../../errors");
    NotFoundError = errorsModule.NotFoundError;
    UnauthorizedError = errorsModule.UnauthorizedError;
    BadRequestError = errorsModule.BadRequestError;
    ConcurrentRunLimitError = errorsModule.ConcurrentRunLimitError;

    const agentSessionModule = await import("../../agent-session");
    agentSessionService = agentSessionModule.agentSessionService;

    // Create test scope for the user (required for compose creation)
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, TEST_SCOPE_ID));
    await globalThis.services.db.insert(scopes).values({
      id: TEST_SCOPE_ID,
      slug: `test-${TEST_SCOPE_ID.slice(0, 8)}`,
      type: "personal",
      ownerId: TEST_USER_ID,
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clean up test data in the correct order (respecting foreign keys)
    // 1. First clean checkpoints (references conversations and runs)
    const testRuns = await globalThis.services.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.userId, TEST_USER_ID));

    for (const run of testRuns) {
      await globalThis.services.db
        .delete(checkpoints)
        .where(eq(checkpoints.runId, run.id));
    }

    // 2. Then clean conversations (references runs)
    for (const run of testRuns) {
      await globalThis.services.db
        .delete(conversations)
        .where(eq(conversations.runId, run.id));
    }

    // 3. Then clean runs (references agentComposeVersions)
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, TEST_USER_ID));
  });

  afterAll(async () => {
    // Final cleanup
    const testRuns = await globalThis.services.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.userId, TEST_USER_ID));

    for (const run of testRuns) {
      await globalThis.services.db
        .delete(checkpoints)
        .where(eq(checkpoints.runId, run.id));
      await globalThis.services.db
        .delete(conversations)
        .where(eq(conversations.runId, run.id));
    }

    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.userId, TEST_USER_ID));
  });

  describe("calculateSessionHistoryPath", () => {
    test("handles simple workspace path", () => {
      const result = calculateSessionHistoryPath("/workspace", "session-123");
      expect(result).toBe(
        "/home/user/.claude/projects/-workspace/session-123.jsonl",
      );
    });

    test("handles nested path", () => {
      const result = calculateSessionHistoryPath(
        "/home/user/projects/myapp",
        "session-456",
      );
      expect(result).toBe(
        "/home/user/.claude/projects/-home-user-projects-myapp/session-456.jsonl",
      );
    });

    test("handles path with multiple leading slashes", () => {
      const result = calculateSessionHistoryPath("/test/path", "abc");
      expect(result).toBe("/home/user/.claude/projects/-test-path/abc.jsonl");
    });

    test("handles single directory path", () => {
      const result = calculateSessionHistoryPath("/myproject", "xyz");
      expect(result).toBe("/home/user/.claude/projects/-myproject/xyz.jsonl");
    });

    test("preserves session ID exactly", () => {
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      const result = calculateSessionHistoryPath("/workspace", sessionId);
      expect(result).toContain(sessionId);
    });

    test("returns claude-code path by default", () => {
      const result = calculateSessionHistoryPath("/workspace", "session-123");
      expect(result).toBe(
        "/home/user/.claude/projects/-workspace/session-123.jsonl",
      );
    });

    test("returns claude-code path when agent type is claude-code", () => {
      const result = calculateSessionHistoryPath(
        "/workspace",
        "session-123",
        "claude-code",
      );
      expect(result).toBe(
        "/home/user/.claude/projects/-workspace/session-123.jsonl",
      );
    });

    test("returns codex path when agent type is codex", () => {
      const result = calculateSessionHistoryPath(
        "/workspace",
        "thread-abc123",
        "codex",
      );
      expect(result).toBe("/home/user/.codex/sessions/thread-abc123.jsonl");
    });

    test("codex path ignores working directory", () => {
      const result1 = calculateSessionHistoryPath(
        "/workspace",
        "thread-123",
        "codex",
      );
      const result2 = calculateSessionHistoryPath(
        "/home/user/projects/myapp",
        "thread-123",
        "codex",
      );
      // Codex uses same path regardless of working directory
      expect(result1).toBe(result2);
      expect(result1).toBe("/home/user/.codex/sessions/thread-123.jsonl");
    });
  });

  describe("RunService", () => {
    let runService: InstanceType<typeof RunService>;

    beforeEach(() => {
      runService = new RunService();
    });

    describe("createRunContext", () => {
      test("creates basic execution context", async () => {
        const context = await runService.createRunContext(
          "run-123",
          "compose-456",
          "test prompt",
          "sandbox-token",
          { userId: "user-1" },
          { apiKey: "secret-123" },
          { agents: { "test-agent": { working_dir: "/workspace" } } },
          "user-1",
          "artifact-name",
          "v1",
        );

        expect(context.runId).toBe("run-123");
        expect(context.agentComposeVersionId).toBe("compose-456");
        expect(context.prompt).toBe("test prompt");
        expect(context.sandboxToken).toBe("sandbox-token");
        expect(context.vars).toEqual({ userId: "user-1" });
        expect(context.secrets).toEqual({ apiKey: "secret-123" });
        expect(context.userId).toBe("user-1");
        expect(context.artifactName).toBe("artifact-name");
        expect(context.artifactVersion).toBe("v1");
      });

      test("handles undefined vars and secrets", async () => {
        const context = await runService.createRunContext(
          "run-123",
          "compose-456",
          "test prompt",
          "sandbox-token",
          undefined,
          undefined,
          {},
        );

        expect(context.vars).toBeUndefined();
        expect(context.secrets).toBeUndefined();
      });
    });

    describe("checkConcurrencyLimit", () => {
      // Test setup using real database operations
      const LIMIT_TEST_USER = `concurrent-limit-test-${Date.now()}`;
      const LIMIT_TEST_SCOPE_ID = randomUUID();
      let limitTestComposeId: string;
      let limitTestVersionId: string;

      beforeAll(async () => {
        // Create test scope
        await globalThis.services.db.insert(scopes).values({
          id: LIMIT_TEST_SCOPE_ID,
          slug: `limit-test-${LIMIT_TEST_SCOPE_ID.slice(0, 8)}`,
          type: "personal",
          ownerId: LIMIT_TEST_USER,
        });

        // Create test compose
        limitTestComposeId = randomUUID();
        await globalThis.services.db.insert(agentComposes).values({
          id: limitTestComposeId,
          name: "limit-test-compose",
          userId: LIMIT_TEST_USER,
          scopeId: LIMIT_TEST_SCOPE_ID,
        });

        // Create test version
        limitTestVersionId = `limit-test-version-${Date.now()}`;
        await globalThis.services.db.insert(agentComposeVersions).values({
          id: limitTestVersionId,
          composeId: limitTestComposeId,
          content: { agents: { test: { working_dir: "/workspace" } } },
          createdBy: LIMIT_TEST_USER,
        });
      });

      afterAll(async () => {
        // Clean up in reverse order of creation
        await globalThis.services.db
          .delete(agentRuns)
          .where(eq(agentRuns.userId, LIMIT_TEST_USER));
        await globalThis.services.db
          .delete(agentComposeVersions)
          .where(eq(agentComposeVersions.id, limitTestVersionId));
        await globalThis.services.db
          .delete(agentComposes)
          .where(eq(agentComposes.id, limitTestComposeId));
        await globalThis.services.db
          .delete(scopes)
          .where(eq(scopes.id, LIMIT_TEST_SCOPE_ID));
      });

      afterEach(async () => {
        // Clean up runs after each test
        await globalThis.services.db
          .delete(agentRuns)
          .where(eq(agentRuns.userId, LIMIT_TEST_USER));
      });

      test("passes when no active runs exist for user", async () => {
        // User has no runs in DB - should pass
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 1),
        ).resolves.toBeUndefined();
      });

      test("skips check entirely when limit is 0 (no limit)", async () => {
        // Create an active run
        await globalThis.services.db.insert(agentRuns).values({
          userId: LIMIT_TEST_USER,
          agentComposeVersionId: limitTestVersionId,
          status: "running",
          prompt: "test",
        });

        // With limit 0, should pass regardless of active runs
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 0),
        ).resolves.toBeUndefined();
      });

      test("respects higher limit values", async () => {
        // Create one active run
        await globalThis.services.db.insert(agentRuns).values({
          userId: LIMIT_TEST_USER,
          agentComposeVersionId: limitTestVersionId,
          status: "running",
          prompt: "test",
        });

        // With high limit, should pass
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 100),
        ).resolves.toBeUndefined();
      });

      test("throws ConcurrentRunLimitError when active runs >= limit", async () => {
        // Create one active run
        await globalThis.services.db.insert(agentRuns).values({
          userId: LIMIT_TEST_USER,
          agentComposeVersionId: limitTestVersionId,
          status: "running",
          prompt: "test",
        });

        // Limit is 1, user has 1 active run - should throw
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 1),
        ).rejects.toThrow(ConcurrentRunLimitError);
      });

      test("throws ConcurrentRunLimitError when active runs exceed limit", async () => {
        // Create multiple active runs
        await globalThis.services.db.insert(agentRuns).values([
          {
            userId: LIMIT_TEST_USER,
            agentComposeVersionId: limitTestVersionId,
            status: "running",
            prompt: "test 1",
          },
          {
            userId: LIMIT_TEST_USER,
            agentComposeVersionId: limitTestVersionId,
            status: "pending",
            prompt: "test 2",
          },
        ]);

        // Limit is 1, user has 2 active runs - should throw
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 1),
        ).rejects.toThrow(ConcurrentRunLimitError);
      });

      test("passes when active runs below limit", async () => {
        // Create one active run
        await globalThis.services.db.insert(agentRuns).values({
          userId: LIMIT_TEST_USER,
          agentComposeVersionId: limitTestVersionId,
          status: "running",
          prompt: "test",
        });

        // Limit is 3, user has 1 active run - should pass
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 3),
        ).resolves.toBeUndefined();
      });

      test("only counts pending and running statuses", async () => {
        // Create runs with non-active statuses
        await globalThis.services.db.insert(agentRuns).values([
          {
            userId: LIMIT_TEST_USER,
            agentComposeVersionId: limitTestVersionId,
            status: "completed",
            prompt: "completed run",
          },
          {
            userId: LIMIT_TEST_USER,
            agentComposeVersionId: limitTestVersionId,
            status: "failed",
            prompt: "failed run",
          },
          {
            userId: LIMIT_TEST_USER,
            agentComposeVersionId: limitTestVersionId,
            status: "timeout",
            prompt: "timeout run",
          },
        ]);

        // No pending/running runs, should pass with limit 1
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 1),
        ).resolves.toBeUndefined();
      });

      test("ConcurrentRunLimitError has descriptive message", () => {
        const error = new ConcurrentRunLimitError();
        expect(error.message).toMatch(/concurrent/i);
        expect(error.message).toMatch(/limit/i);
      });

      test("ConcurrentRunLimitError returns 429 status code", () => {
        const error = new ConcurrentRunLimitError();
        expect(error.statusCode).toBe(429);
      });

      test("falls back to default when CONCURRENT_RUN_LIMIT is invalid", async () => {
        vi.stubEnv("CONCURRENT_RUN_LIMIT", "invalid");

        try {
          // User has no runs, should pass with default limit of 1
          await expect(
            runService.checkConcurrencyLimit(LIMIT_TEST_USER),
          ).resolves.toBeUndefined();
        } finally {
          vi.unstubAllEnvs();
        }
      });
    });

    describe("buildExecutionContext", () => {
      describe("new run mode", () => {
        test("builds context for new run with real database", async () => {
          // Create a test agent compose and version
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: TEST_USER_ID,
              scopeId: TEST_SCOPE_ID,
              name: "test-compose-run-service",
            })
            .returning();

          const versionId = "test-version-sha-for-run-service-test-123";
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  working_dir: "/workspace",
                  environment: { ANTHROPIC_API_KEY: "test-key" },
                },
              },
            },
            createdBy: TEST_USER_ID,
          });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: "run-123",
            sandboxToken: "token",
            userId: TEST_USER_ID,
            artifactName: "artifact-1",
            artifactVersion: "v1",
            vars: { foo: "bar" },
            volumeVersions: { vol1: "version1" },
          });

          expect(context.runId).toBe("run-123");
          expect(context.agentComposeVersionId).toBe(versionId);
          expect(context.prompt).toBe("test prompt");
          expect(context.artifactName).toBe("artifact-1");
          expect(context.artifactVersion).toBe("v1");
          expect(context.vars).toEqual({ foo: "bar" });
          expect(context.volumeVersions).toEqual({ vol1: "version1" });
          expect(context.resumeSession).toBeUndefined();
          expect(context.resumeArtifact).toBeUndefined();

          // Cleanup
          await globalThis.services.db
            .delete(agentComposeVersions)
            .where(eq(agentComposeVersions.id, versionId));
          await globalThis.services.db
            .delete(agentComposes)
            .where(eq(agentComposes.id, compose!.id));
        });

        test("throws NotFoundError when compose not found", async () => {
          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: "non-existent-uuid",
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: TEST_USER_ID,
            }),
          ).rejects.toThrow(NotFoundError);
        });

        test("throws NotFoundError when no agentComposeVersionId provided for new run", async () => {
          await expect(
            runService.buildExecutionContext({
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: TEST_USER_ID,
            }),
          ).rejects.toThrow(NotFoundError);
        });
      });

      describe("session continue mode", () => {
        test("throws NotFoundError when session not found", async () => {
          vi.mocked(
            agentSessionService.getByIdWithConversation,
          ).mockResolvedValueOnce(null as never);

          await expect(
            runService.buildExecutionContext({
              sessionId: "non-existent",
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: TEST_USER_ID,
            }),
          ).rejects.toThrow(NotFoundError);
        });

        test("throws UnauthorizedError when session belongs to different user", async () => {
          const mockSession = {
            id: "session-123",
            userId: "different-user",
            agentComposeVersionId: "compose-123",
          };

          vi.mocked(
            agentSessionService.getByIdWithConversation,
          ).mockResolvedValueOnce(mockSession as never);

          await expect(
            runService.buildExecutionContext({
              sessionId: "session-123",
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: TEST_USER_ID,
            }),
          ).rejects.toThrow(UnauthorizedError);
        });

        test("throws NotFoundError when session has no conversation", async () => {
          const mockSession = {
            id: "session-123",
            userId: TEST_USER_ID,
            agentComposeVersionId: "compose-123",
            conversation: null,
          };

          vi.mocked(
            agentSessionService.getByIdWithConversation,
          ).mockResolvedValueOnce(mockSession as never);

          await expect(
            runService.buildExecutionContext({
              sessionId: "session-123",
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: TEST_USER_ID,
            }),
          ).rejects.toThrow(NotFoundError);
        });
      });

      describe("credential merging into secrets", () => {
        // Each test uses its own unique user ID and scope to ensure isolation
        // This is necessary because buildExecutionContext uses getUserScopeByClerkId
        // to find the scope, and we need credentials to be in that exact scope

        test("merges credentials into secrets for masking", async () => {
          // Create unique user and scope for this test
          const testUserId = `cred-merge-user-${Date.now()}`;
          const testScopeId = randomUUID();

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `cred-merge-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create real credential in the database
          const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
          await globalThis.services.db.insert(credentials).values({
            scopeId: testScopeId,
            name: "MY_CREDENTIAL",
            encryptedValue: encryptCredentialValue(
              "credential-secret-value",
              encryptionKey,
            ),
          });

          // Create a compose with credential references in environment
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-credential-merge",
            })
            .returning();

          const versionId = `test-version-cred-merge-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  working_dir: "/workspace",
                  environment: {
                    ANTHROPIC_API_KEY: "test-api-key",
                    MY_CRED: "${{ credentials.MY_CREDENTIAL }}",
                  },
                },
              },
            },
            createdBy: testUserId,
          });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-cred-merge-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
          });

          // Credentials should be merged into secrets for masking
          expect(context.secrets).toEqual({
            MY_CREDENTIAL: "credential-secret-value",
          });

          // Cleanup
          await globalThis.services.db
            .delete(agentComposeVersions)
            .where(eq(agentComposeVersions.id, versionId));
          await globalThis.services.db
            .delete(agentComposes)
            .where(eq(agentComposes.id, compose!.id));
          await globalThis.services.db
            .delete(credentials)
            .where(eq(credentials.scopeId, testScopeId));
          await globalThis.services.db
            .delete(scopes)
            .where(eq(scopes.id, testScopeId));
        });

        test("CLI secrets take priority over credentials on collision", async () => {
          // Create unique user and scope for this test
          const testUserId = `cred-priority-user-${Date.now()}`;
          const testScopeId = randomUUID();

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `cred-priority-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create real credential in the database
          const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
          await globalThis.services.db.insert(credentials).values({
            scopeId: testScopeId,
            name: "API_KEY",
            encryptedValue: encryptCredentialValue(
              "credential-value",
              encryptionKey,
            ),
          });

          // Create a compose with credential references
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-priority",
            })
            .returning();

          const versionId = `test-version-priority-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  working_dir: "/workspace",
                  environment: {
                    ANTHROPIC_API_KEY: "test-api-key",
                    API_KEY: "${{ credentials.API_KEY }}",
                  },
                },
              },
            },
            createdBy: testUserId,
          });

          // Pass CLI secret with same name
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-priority-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
            secrets: { API_KEY: "cli-secret-value" },
          });

          // CLI secret should win over credential
          expect(context.secrets).toEqual({
            API_KEY: "cli-secret-value",
          });

          // Cleanup
          await globalThis.services.db
            .delete(agentComposeVersions)
            .where(eq(agentComposeVersions.id, versionId));
          await globalThis.services.db
            .delete(agentComposes)
            .where(eq(agentComposes.id, compose!.id));
          await globalThis.services.db
            .delete(credentials)
            .where(eq(credentials.scopeId, testScopeId));
          await globalThis.services.db
            .delete(scopes)
            .where(eq(scopes.id, testScopeId));
        });

        test("merges multiple credentials with multiple CLI secrets", async () => {
          // Create unique user and scope for this test
          const testUserId = `cred-multi-user-${Date.now()}`;
          const testScopeId = randomUUID();

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `cred-multi-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create real credentials in the database
          const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
          await globalThis.services.db.insert(credentials).values([
            {
              scopeId: testScopeId,
              name: "CRED_A",
              encryptedValue: encryptCredentialValue(
                "cred-a-value",
                encryptionKey,
              ),
            },
            {
              scopeId: testScopeId,
              name: "CRED_B",
              encryptedValue: encryptCredentialValue(
                "cred-b-value",
                encryptionKey,
              ),
            },
          ]);

          // Create a compose with multiple credential references
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-multi",
            })
            .returning();

          const versionId = `test-version-multi-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  working_dir: "/workspace",
                  environment: {
                    ANTHROPIC_API_KEY: "test-api-key",
                    CRED_A: "${{ credentials.CRED_A }}",
                    CRED_B: "${{ credentials.CRED_B }}",
                  },
                },
              },
            },
            createdBy: testUserId,
          });

          // Pass CLI secrets (some overlap, some new)
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-multi-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
            secrets: {
              CRED_B: "cli-b-value", // Overlaps with credential
              CLI_SECRET: "cli-only-value", // CLI only
            },
          });

          // Should have all values with CLI taking priority
          expect(context.secrets).toEqual({
            CRED_A: "cred-a-value", // From credential
            CRED_B: "cli-b-value", // CLI wins over credential
            CLI_SECRET: "cli-only-value", // CLI only
          });

          // Cleanup
          await globalThis.services.db
            .delete(agentComposeVersions)
            .where(eq(agentComposeVersions.id, versionId));
          await globalThis.services.db
            .delete(agentComposes)
            .where(eq(agentComposes.id, compose!.id));
          await globalThis.services.db
            .delete(credentials)
            .where(eq(credentials.scopeId, testScopeId));
          await globalThis.services.db
            .delete(scopes)
            .where(eq(scopes.id, testScopeId));
        });
      });

      describe("model provider credential injection", () => {
        // Track created scope IDs for cleanup (AP-4: use afterEach for robustness)
        const createdScopeIds = new Set<string>();

        afterEach(async () => {
          // Clean up all resources for tracked scopes in correct order
          for (const scopeId of createdScopeIds) {
            // 1. Delete model providers (references credentials)
            await globalThis.services.db
              .delete(modelProviders)
              .where(eq(modelProviders.scopeId, scopeId));

            // 2. Find and delete compose versions for this scope
            const scopeComposes = await globalThis.services.db
              .select({ id: agentComposes.id })
              .from(agentComposes)
              .where(eq(agentComposes.scopeId, scopeId));

            for (const compose of scopeComposes) {
              await globalThis.services.db
                .delete(agentComposeVersions)
                .where(eq(agentComposeVersions.composeId, compose.id));
            }

            // 3. Delete composes
            await globalThis.services.db
              .delete(agentComposes)
              .where(eq(agentComposes.scopeId, scopeId));

            // 4. Delete credentials
            await globalThis.services.db
              .delete(credentials)
              .where(eq(credentials.scopeId, scopeId));

            // 5. Delete scope
            await globalThis.services.db
              .delete(scopes)
              .where(eq(scopes.id, scopeId));
          }
          createdScopeIds.clear();
        });

        test("skips injection when compose has explicit ANTHROPIC_API_KEY", async () => {
          const testUserId = `model-provider-skip-anthro-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-skip-anthro-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create a compose with explicit model provider config
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-explicit-anthropic",
            })
            .returning();

          const versionId = `test-version-explicit-anthro-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  working_dir: "/workspace",
                  environment: {
                    // Explicit model provider config - injection should be skipped
                    ANTHROPIC_API_KEY: "explicit-api-key-value",
                  },
                },
              },
            },
            createdBy: testUserId,
          });

          // Build context - should NOT throw even without model provider configured
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-explicit-anthro-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
          });

          // No credentials injected from model provider (compose has explicit config)
          expect(context.secrets).toBeUndefined();
        });

        test("skips injection when compose has explicit OPENAI_API_KEY", async () => {
          const testUserId = `model-provider-skip-openai-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-skip-openai-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-explicit-openai",
            })
            .returning();

          const versionId = `test-version-explicit-openai-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "codex",
                  working_dir: "/workspace",
                  environment: {
                    OPENAI_API_KEY: "explicit-openai-key",
                  },
                },
              },
            },
            createdBy: testUserId,
          });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-explicit-openai-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
          });

          expect(context.secrets).toBeUndefined();
        });

        test("skips injection when compose has alternative auth method (CLAUDE_CODE_USE_FOUNDRY)", async () => {
          const testUserId = `model-provider-skip-foundry-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-skip-foundry-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create a compose with Azure Foundry config (alternative auth)
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-foundry",
            })
            .returning();

          const versionId = `test-version-foundry-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  working_dir: "/workspace",
                  environment: {
                    // Alternative auth - should be detected as explicit LLM config
                    CLAUDE_CODE_USE_FOUNDRY: "1",
                  },
                },
              },
            },
            createdBy: testUserId,
          });

          // Build context - should NOT throw even without model provider configured
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-foundry-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
          });

          // No credentials injected from model provider (compose has alternative auth)
          expect(context.secrets).toBeUndefined();
        });

        test("uses specified model provider when --model-provider is passed", async () => {
          const testUserId = `model-provider-explicit-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);
          const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-explicit-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create credential for the model provider
          const [credential] = await globalThis.services.db
            .insert(credentials)
            .values({
              scopeId: testScopeId,
              name: "ANTHROPIC_API_KEY",
              encryptedValue: encryptCredentialValue(
                "test-anthropic-api-key-value",
                encryptionKey,
              ),
            })
            .returning();

          // Create model provider
          await globalThis.services.db.insert(modelProviders).values({
            scopeId: testScopeId,
            type: "anthropic-api-key",
            credentialId: credential!.id,
            isDefault: false,
          });

          // Create compose WITHOUT explicit model provider config
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-no-mp-config",
            })
            .returning();

          const versionId = `test-version-no-mp-config-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  working_dir: "/workspace",
                  environment: {
                    SOME_VAR: "some-value",
                  },
                },
              },
            },
            createdBy: testUserId,
          });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-explicit-mp-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
            modelProvider: "anthropic-api-key",
          });

          // Credential should be injected
          expect(context.secrets).toEqual({
            ANTHROPIC_API_KEY: "test-anthropic-api-key-value",
          });
        });

        test("uses default model provider when no explicit config", async () => {
          const testUserId = `model-provider-default-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);
          const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-default-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create credential for the default model provider
          const [credential] = await globalThis.services.db
            .insert(credentials)
            .values({
              scopeId: testScopeId,
              name: "ANTHROPIC_API_KEY",
              encryptedValue: encryptCredentialValue(
                "default-provider-key-value",
                encryptionKey,
              ),
            })
            .returning();

          // Create default model provider
          await globalThis.services.db.insert(modelProviders).values({
            scopeId: testScopeId,
            type: "anthropic-api-key",
            credentialId: credential!.id,
            isDefault: true, // This is the default!
          });

          // Create compose WITHOUT explicit model provider config
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-default-mp",
            })
            .returning();

          const versionId = `test-version-default-mp-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  working_dir: "/workspace",
                  environment: {},
                },
              },
            },
            createdBy: testUserId,
          });

          // No modelProvider param - should use default
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-default-mp-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
          });

          // Default credential should be injected
          expect(context.secrets).toEqual({
            ANTHROPIC_API_KEY: "default-provider-key-value",
          });
        });

        test("throws BadRequestError when no model provider configured", async () => {
          const testUserId = `model-provider-none-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-none-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create compose WITHOUT explicit model provider config and NO model provider
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-no-mp",
            })
            .returning();

          const versionId = `test-version-no-mp-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  working_dir: "/workspace",
                  environment: {},
                },
              },
            },
            createdBy: testUserId,
          });

          // Should throw helpful error
          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-no-mp-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
            }),
          ).rejects.toThrow(BadRequestError);

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-no-mp-2-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
            }),
          ).rejects.toThrow(/No model provider configured/);
        });

        test("throws BadRequestError when model provider type is invalid", async () => {
          const testUserId = `model-provider-invalid-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-invalid-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-invalid-mp",
            })
            .returning();

          const versionId = `test-version-invalid-mp-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  working_dir: "/workspace",
                  environment: {},
                },
              },
            },
            createdBy: testUserId,
          });

          // Pass invalid model provider type
          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-invalid-mp-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
              modelProvider: "non-existent-provider",
            }),
          ).rejects.toThrow(BadRequestError);

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-invalid-mp-2-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
              modelProvider: "non-existent-provider",
            }),
          ).rejects.toThrow(/Unknown model provider type/);
        });

        test("throws BadRequestError when model provider incompatible with framework", async () => {
          const testUserId = `model-provider-mismatch-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);
          const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-mismatch-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create credential for OpenAI
          const [credential] = await globalThis.services.db
            .insert(credentials)
            .values({
              scopeId: testScopeId,
              name: "OPENAI_API_KEY",
              encryptedValue: encryptCredentialValue(
                "test-openai-key",
                encryptionKey,
              ),
            })
            .returning();

          // Create OpenAI model provider
          await globalThis.services.db.insert(modelProviders).values({
            scopeId: testScopeId,
            type: "openai-api-key",
            credentialId: credential!.id,
            isDefault: false,
          });

          // Create claude-code compose (incompatible with openai-api-key)
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-mismatch",
            })
            .returning();

          const versionId = `test-version-mismatch-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code", // claude-code agent
                  working_dir: "/workspace",
                  environment: {},
                },
              },
            },
            createdBy: testUserId,
          });

          // Try to use OpenAI provider with claude-code framework
          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-mismatch-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
              modelProvider: "openai-api-key",
            }),
          ).rejects.toThrow(BadRequestError);

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-mismatch-2-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
              modelProvider: "openai-api-key",
            }),
          ).rejects.toThrow(/not compatible with framework/);
        });

        test("auto-injects model provider credential into environment when no environment block exists", async () => {
          const testUserId = `model-provider-auto-inject-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);
          const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-auto-inject-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create credential for the default model provider
          const [credential] = await globalThis.services.db
            .insert(credentials)
            .values({
              scopeId: testScopeId,
              name: "CLAUDE_CODE_OAUTH_TOKEN",
              encryptedValue: encryptCredentialValue(
                "test-oauth-token-value",
                encryptionKey,
              ),
            })
            .returning();

          // Create default model provider
          await globalThis.services.db.insert(modelProviders).values({
            scopeId: testScopeId,
            type: "claude-code-oauth-token",
            credentialId: credential!.id,
            isDefault: true,
          });

          // Create compose WITHOUT any environment block (the bug scenario)
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-no-env-block",
            })
            .returning();

          const versionId = `test-version-no-env-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  working_dir: "/workspace",
                  // NO environment block at all!
                },
              },
            },
            createdBy: testUserId,
          });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-auto-inject-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
          });

          // BUG FIX: context.environment should contain the model provider credential
          expect(context.environment).toBeDefined();
          expect(context.environment!["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(
            "test-oauth-token-value",
          );

          // Secrets should also contain the credential (for log masking)
          expect(context.secrets).toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token-value",
          });
        });

        test("user-defined environment takes precedence over auto-injected credential", async () => {
          const testUserId = `model-provider-precedence-${Date.now()}`;
          const testScopeId = randomUUID();
          createdScopeIds.add(testScopeId);
          const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

          await globalThis.services.db.insert(scopes).values({
            id: testScopeId,
            slug: `mp-precedence-${Date.now()}`,
            type: "personal",
            ownerId: testUserId,
          });

          // Create credential for the default model provider
          const [credential] = await globalThis.services.db
            .insert(credentials)
            .values({
              scopeId: testScopeId,
              name: "ANTHROPIC_API_KEY",
              encryptedValue: encryptCredentialValue(
                "model-provider-key",
                encryptionKey,
              ),
            })
            .returning();

          await globalThis.services.db.insert(modelProviders).values({
            scopeId: testScopeId,
            type: "anthropic-api-key",
            credentialId: credential!.id,
            isDefault: true,
          });

          // Create compose WITH explicit environment value
          const [compose] = await globalThis.services.db
            .insert(agentComposes)
            .values({
              userId: testUserId,
              scopeId: testScopeId,
              name: "test-compose-user-precedence",
            })
            .returning();

          const versionId = `test-version-precedence-${Date.now()}`;
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: {
                "test-agent": {
                  framework: "claude-code",
                  working_dir: "/workspace",
                  environment: {
                    ANTHROPIC_API_KEY: "user-defined-key", // User explicitly sets this
                  },
                },
              },
            },
            createdBy: testUserId,
          });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-precedence-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
          });

          // User-defined value should win (skips model provider injection due to hasExplicitModelProviderConfig)
          expect(context.environment!["ANTHROPIC_API_KEY"]).toBe(
            "user-defined-key",
          );
        });
      });
    });
  });
});
