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
import { agentSessions } from "../../../db/schema/agent-session";
import { randomUUID } from "crypto";
import { Sandbox } from "@e2b/code-interpreter";
import { calculateSessionHistoryPath, RunService } from "../run-service";
import {
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
  ConcurrentRunLimitError,
} from "../../errors";
import { AgentSessionService } from "../../agent-session/agent-session-service";
import { mockClerk, clearClerkMock } from "../../../__tests__/clerk-mock";
import {
  createTestDataContext,
  type TestDataContext,
} from "../../../__tests__/api-test-helpers";
import { POST as createCompose } from "../../../../app/api/agent/composes/route";
import { POST as createScope } from "../../../../app/api/scope/route";
import { PUT as setCredential } from "../../../../app/api/credentials/route";
import { PUT as upsertModelProvider } from "../../../../app/api/model-providers/route";
import { POST as setModelProviderDefault } from "../../../../app/api/model-providers/[type]/set-default/route";
import { POST as createRunRoute } from "../../../../app/api/agent/runs/route";
import { createTestRequest } from "../../../__tests__/api-test-helpers";
import * as s3Client from "../../s3/s3-client";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

const TEST_USER_ID = `test-user-run-service-${Date.now()}-${process.pid}`;
const TEST_AGENT_NAME = `test-agent-run-service-${Date.now()}`;

describe("run-service", () => {
  let testComposeId: string;
  let testVersionId: string;
  let ctx: TestDataContext;

  beforeAll(async () => {
    initServices();

    // Create test data context for API-based test data creation
    ctx = createTestDataContext({
      scopeRoute: createScope,
      composeRoute: createCompose,
      credentialRoute: setCredential,
      modelProviderRoute: upsertModelProvider,
      setDefaultRoute: setModelProviderDefault,
    });

    // Setup E2B SDK mock - create sandbox
    const mockSandbox = {
      sandboxId: "test-sandbox-123",
      getHostname: () => "test-sandbox.e2b.dev",
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

    // Setup S3 mocks
    vi.spyOn(s3Client, "generatePresignedUrl").mockResolvedValue(
      "https://mock-presigned-url",
    );
    vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]);
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);

    // Mock Clerk auth
    mockClerk({ userId: TEST_USER_ID });

    // Create test scope and compose via API
    await ctx.createScope(`test-scope-${Date.now()}`);

    const composeData = await ctx.createCompose(TEST_AGENT_NAME);
    testComposeId = composeData.composeId;
    testVersionId = composeData.versionId;
  });

  beforeEach(async () => {
    // Re-setup mocks after clearAllMocks
    const mockSandbox = {
      sandboxId: "test-sandbox-123",
      getHostname: () => "test-sandbox.e2b.dev",
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

    vi.spyOn(s3Client, "generatePresignedUrl").mockResolvedValue(
      "https://mock-presigned-url",
    );
    vi.spyOn(s3Client, "listS3Objects").mockResolvedValue([]);
    vi.spyOn(s3Client, "uploadS3Buffer").mockResolvedValue(undefined);

    mockClerk({ userId: TEST_USER_ID });

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

    // 4. Clean sessions
    await globalThis.services.db
      .delete(agentSessions)
      .where(eq(agentSessions.userId, TEST_USER_ID));
  });

  afterEach(async () => {
    clearClerkMock();
  });

  afterAll(async () => {
    clearClerkMock();
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
      // Test setup using API endpoints
      const LIMIT_TEST_USER = `concurrent-limit-test-${Date.now()}-${process.pid}`;
      let limitTestScopeId: string;
      let limitTestComposeId: string;

      // Helper to create a run via API and optionally set a specific status
      async function createTestRun(
        status?: "pending" | "running" | "completed" | "failed" | "timeout",
      ): Promise<string> {
        mockClerk({ userId: LIMIT_TEST_USER });
        const request = createTestRequest(
          "http://localhost:3000/api/agent/runs",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentComposeId: limitTestComposeId,
              prompt: `test prompt ${Date.now()}`,
            }),
          },
        );
        const response = await createRunRoute(request);
        const data = await response.json();
        mockClerk({ userId: TEST_USER_ID });

        // If a specific status is needed (other than what API creates), update it
        if (status && status !== "running") {
          await globalThis.services.db
            .update(agentRuns)
            .set({ status })
            .where(eq(agentRuns.id, data.runId));
        }

        return data.runId;
      }

      beforeAll(async () => {
        // Mock Clerk for limit test user
        mockClerk({ userId: LIMIT_TEST_USER });

        // Create test scope and compose via API
        const scopeData = await ctx.createScope(`limit-test-${Date.now()}`);
        limitTestScopeId = scopeData.id;

        const composeData = await ctx.createCompose(
          `limit-test-agent-${Date.now()}`,
        );
        limitTestComposeId = composeData.composeId;

        // Restore Clerk mock to default test user
        mockClerk({ userId: TEST_USER_ID });
      });

      afterAll(async () => {
        // Clean up in reverse order of creation (respecting foreign keys)
        // 1. Delete runs
        await globalThis.services.db
          .delete(agentRuns)
          .where(eq(agentRuns.userId, LIMIT_TEST_USER));

        // 2. Delete compose versions for this scope's composes
        const scopeComposes = await globalThis.services.db
          .select({ id: agentComposes.id })
          .from(agentComposes)
          .where(eq(agentComposes.scopeId, limitTestScopeId));

        for (const compose of scopeComposes) {
          await globalThis.services.db
            .delete(agentComposeVersions)
            .where(eq(agentComposeVersions.composeId, compose.id));
        }

        // 3. Delete composes
        await globalThis.services.db
          .delete(agentComposes)
          .where(eq(agentComposes.scopeId, limitTestScopeId));

        // 4. Delete scope
        await globalThis.services.db
          .delete(scopes)
          .where(eq(scopes.id, limitTestScopeId));
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
        // Create an active run via API
        await createTestRun("running");

        // With limit 0, should pass regardless of active runs
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 0),
        ).resolves.toBeUndefined();
      });

      test("respects higher limit values", async () => {
        // Create one active run via API
        await createTestRun("running");

        // With high limit, should pass
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 100),
        ).resolves.toBeUndefined();
      });

      test("throws ConcurrentRunLimitError when active runs >= limit", async () => {
        // Create one active run via API
        await createTestRun("running");

        // Limit is 1, user has 1 active run - should throw
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 1),
        ).rejects.toThrow(ConcurrentRunLimitError);
      });

      test("throws ConcurrentRunLimitError when active runs exceed limit", async () => {
        // Create multiple active runs via API
        await createTestRun("running");
        await createTestRun("pending");

        // Limit is 1, user has 2 active runs - should throw
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 1),
        ).rejects.toThrow(ConcurrentRunLimitError);
      });

      test("passes when active runs below limit", async () => {
        // Create one active run via API
        await createTestRun("running");

        // Limit is 3, user has 1 active run - should pass
        await expect(
          runService.checkConcurrencyLimit(LIMIT_TEST_USER, 3),
        ).resolves.toBeUndefined();
      });

      test("only counts pending and running statuses", async () => {
        // Create runs with non-active statuses via API then update status
        await createTestRun("completed");
        await createTestRun("failed");
        await createTestRun("timeout");

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
          // Create a test agent compose via API
          const composeData = await ctx.createCompose(
            `test-compose-run-service-${Date.now()}`,
            {
              working_dir: "/workspace",
              environment: { ANTHROPIC_API_KEY: "test-key" },
            },
          );

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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
          expect(context.agentComposeVersionId).toBe(composeData.versionId);
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
            .where(eq(agentComposeVersions.id, composeData.versionId));
          await globalThis.services.db
            .delete(agentComposes)
            .where(eq(agentComposes.id, composeData.composeId));
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
        const agentSessionService = new AgentSessionService();

        test("throws NotFoundError when session not found", async () => {
          // No session exists with this ID - real service returns null
          await expect(
            runService.buildExecutionContext({
              sessionId: randomUUID(),
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: TEST_USER_ID,
            }),
          ).rejects.toThrow(NotFoundError);
        });

        test("throws UnauthorizedError when session belongs to different user", async () => {
          // Create a session for a different user
          const differentUserId = `different-user-${Date.now()}`;

          // Create scope for different user via API
          mockClerk({ userId: differentUserId });
          const scopeData = await ctx.createScope(
            `diff-${Date.now().toString(36)}`,
          );
          mockClerk({ userId: TEST_USER_ID });

          // Create session for different user
          const session = await agentSessionService.create({
            userId: differentUserId,
            agentComposeId: testComposeId,
            agentComposeVersionId: testVersionId,
            artifactName: "test-artifact",
          });

          try {
            // Try to access session as TEST_USER_ID
            await expect(
              runService.buildExecutionContext({
                sessionId: session.id,
                prompt: "test",
                runId: "run-123",
                sandboxToken: "token",
                userId: TEST_USER_ID,
              }),
            ).rejects.toThrow(UnauthorizedError);
          } finally {
            // Cleanup
            await globalThis.services.db
              .delete(agentSessions)
              .where(eq(agentSessions.id, session.id));
            await globalThis.services.db
              .delete(scopes)
              .where(eq(scopes.id, scopeData.id));
          }
        });

        test("throws NotFoundError when session has no conversation", async () => {
          // Create session WITHOUT conversation
          const session = await agentSessionService.create({
            userId: TEST_USER_ID,
            agentComposeId: testComposeId,
            agentComposeVersionId: testVersionId,
            artifactName: "test-artifact-no-conversation",
            // No conversationId - conversation will be null
          });

          try {
            await expect(
              runService.buildExecutionContext({
                sessionId: session.id,
                prompt: "test",
                runId: "run-123",
                sandboxToken: "token",
                userId: TEST_USER_ID,
              }),
            ).rejects.toThrow(NotFoundError);
          } finally {
            // Cleanup
            await globalThis.services.db
              .delete(agentSessions)
              .where(eq(agentSessions.id, session.id));
          }
        });
      });

      describe("credential merging into secrets", () => {
        // Each test uses its own unique user ID and scope to ensure isolation
        // This is necessary because buildExecutionContext uses getUserScopeByClerkId
        // to find the scope, and we need credentials to be in that exact scope

        test("merges credentials into secrets for masking", async () => {
          // Create unique user and scope for this test
          const testUserId = `cred-merge-user-${Date.now()}`;

          // Create scope and credential via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(`cred-merge-${Date.now()}`);
          await ctx.createCredential(
            "MY_CREDENTIAL",
            "credential-secret-value",
          );

          // Create a compose with credential references in environment
          const composeData = await ctx.createCompose(
            "test-compose-credential-merge",
            {
              environment: {
                ANTHROPIC_API_KEY: "test-api-key",
                MY_CRED: "${{ credentials.MY_CREDENTIAL }}",
              },
            },
          );
          mockClerk({ userId: TEST_USER_ID });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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
            .where(eq(agentComposeVersions.id, composeData.versionId));
          await globalThis.services.db
            .delete(agentComposes)
            .where(eq(agentComposes.id, composeData.composeId));
          await globalThis.services.db
            .delete(credentials)
            .where(eq(credentials.scopeId, scopeData.id));
          await globalThis.services.db
            .delete(scopes)
            .where(eq(scopes.id, scopeData.id));
        });

        test("CLI secrets take priority over credentials on collision", async () => {
          // Create unique user and scope for this test
          const testUserId = `cred-priority-user-${Date.now()}`;

          // Create scope, credential and compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(
            `cred-priority-${Date.now()}`,
          );
          await ctx.createCredential("API_KEY", "credential-value");
          const composeData = await ctx.createCompose("test-compose-priority", {
            environment: {
              ANTHROPIC_API_KEY: "test-api-key",
              API_KEY: "${{ credentials.API_KEY }}",
            },
          });
          mockClerk({ userId: TEST_USER_ID });

          // Pass CLI secret with same name
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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
            .where(eq(agentComposeVersions.id, composeData.versionId));
          await globalThis.services.db
            .delete(agentComposes)
            .where(eq(agentComposes.id, composeData.composeId));
          await globalThis.services.db
            .delete(credentials)
            .where(eq(credentials.scopeId, scopeData.id));
          await globalThis.services.db
            .delete(scopes)
            .where(eq(scopes.id, scopeData.id));
        });

        test("merges multiple credentials with multiple CLI secrets", async () => {
          // Create unique user and scope for this test
          const testUserId = `cred-multi-user-${Date.now()}`;

          // Create scope, credentials and compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(`cred-multi-${Date.now()}`);
          await ctx.createCredential("CRED_A", "cred-a-value");
          await ctx.createCredential("CRED_B", "cred-b-value");
          const composeData = await ctx.createCompose("test-compose-multi", {
            environment: {
              ANTHROPIC_API_KEY: "test-api-key",
              CRED_A: "${{ credentials.CRED_A }}",
              CRED_B: "${{ credentials.CRED_B }}",
            },
          });
          mockClerk({ userId: TEST_USER_ID });

          // Pass CLI secrets (some overlap, some new)
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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
            .where(eq(agentComposeVersions.id, composeData.versionId));
          await globalThis.services.db
            .delete(agentComposes)
            .where(eq(agentComposes.id, composeData.composeId));
          await globalThis.services.db
            .delete(credentials)
            .where(eq(credentials.scopeId, scopeData.id));
          await globalThis.services.db
            .delete(scopes)
            .where(eq(scopes.id, scopeData.id));
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

          // Create scope and compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(
            `mp-skip-anthro-${Date.now()}`,
          );
          createdScopeIds.add(scopeData.id);
          const composeData = await ctx.createCompose(
            "test-compose-explicit-anthropic",
            {
              framework: "claude-code",
              // Explicit model provider config - injection should be skipped
              environment: { ANTHROPIC_API_KEY: "explicit-api-key-value" },
            },
          );
          mockClerk({ userId: TEST_USER_ID });

          // Build context - should NOT throw even without model provider configured
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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

          // Create scope and compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(
            `mp-skip-openai-${Date.now()}`,
          );
          createdScopeIds.add(scopeData.id);
          const composeData = await ctx.createCompose(
            "test-compose-explicit-openai",
            {
              framework: "codex",
              environment: { OPENAI_API_KEY: "explicit-openai-key" },
            },
          );
          mockClerk({ userId: TEST_USER_ID });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
            prompt: "test prompt",
            runId: `run-explicit-openai-${Date.now()}`,
            sandboxToken: "token",
            userId: testUserId,
          });

          expect(context.secrets).toBeUndefined();
        });

        test("skips injection when compose has alternative auth method (CLAUDE_CODE_USE_FOUNDRY)", async () => {
          const testUserId = `model-provider-skip-foundry-${Date.now()}`;

          // Create scope and compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(
            `mp-skip-foundry-${Date.now()}`,
          );
          createdScopeIds.add(scopeData.id);
          const composeData = await ctx.createCompose("test-compose-foundry", {
            framework: "claude-code",
            // Alternative auth - should be detected as explicit LLM config
            environment: { CLAUDE_CODE_USE_FOUNDRY: "1" },
          });
          mockClerk({ userId: TEST_USER_ID });

          // Build context - should NOT throw even without model provider configured
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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

          // Create scope, model provider (which creates credential) and compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(`mp-explicit-${Date.now()}`);
          createdScopeIds.add(scopeData.id);
          // Model provider API takes the actual API key value, creates credential automatically
          await ctx.createModelProvider(
            "anthropic-api-key",
            "test-anthropic-api-key-value",
          );
          const composeData = await ctx.createCompose(
            "test-compose-no-mp-config",
            {
              framework: "claude-code",
              environment: { SOME_VAR: "some-value" },
            },
          );
          mockClerk({ userId: TEST_USER_ID });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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

          // Create scope and model provider via API
          // First model provider for a framework is automatically default
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(`mp-default-${Date.now()}`);
          createdScopeIds.add(scopeData.id);
          await ctx.createModelProvider(
            "anthropic-api-key",
            "default-provider-key-value",
          );
          const composeData = await ctx.createCompose(
            "test-compose-default-mp",
            {
              framework: "claude-code",
            },
          );
          mockClerk({ userId: TEST_USER_ID });

          // Remove auto-created ANTHROPIC_API_KEY to trigger default lookup
          await globalThis.services.db
            .update(agentComposeVersions)
            .set({
              content: {
                agents: {
                  "test-compose-default-mp": {
                    framework: "claude-code",
                    working_dir: "/home/user/workspace",
                    environment: {},
                  },
                },
              },
            })
            .where(eq(agentComposeVersions.id, composeData.versionId));

          // No modelProvider param - should use default
          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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

          // Create scope and compose via API (no model provider)
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(`mp-none-${Date.now()}`);
          createdScopeIds.add(scopeData.id);
          // Create compose WITHOUT explicit model provider config and NO model provider
          const composeData = await ctx.createCompose("test-compose-no-mp", {
            framework: "claude-code",
            // No environment - triggers model provider injection
          });
          mockClerk({ userId: TEST_USER_ID });

          // Remove the auto-created ANTHROPIC_API_KEY from the compose version
          // to simulate no LLM config
          await globalThis.services.db
            .update(agentComposeVersions)
            .set({
              content: {
                agents: {
                  "test-compose-no-mp": {
                    framework: "claude-code",
                    working_dir: "/home/user/workspace",
                    environment: {},
                  },
                },
              },
            })
            .where(eq(agentComposeVersions.id, composeData.versionId));

          // Should throw helpful error
          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: composeData.versionId,
              prompt: "test prompt",
              runId: `run-no-mp-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
            }),
          ).rejects.toThrow(BadRequestError);

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: composeData.versionId,
              prompt: "test prompt",
              runId: `run-no-mp-2-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
            }),
          ).rejects.toThrow(/No model provider configured/);
        });

        test("throws BadRequestError when model provider type is invalid", async () => {
          const testUserId = `model-provider-invalid-${Date.now()}`;

          // Create scope and compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(`mp-invalid-${Date.now()}`);
          createdScopeIds.add(scopeData.id);
          const composeData = await ctx.createCompose(
            "test-compose-invalid-mp",
            {
              framework: "claude-code",
            },
          );
          mockClerk({ userId: TEST_USER_ID });

          // Remove auto-created ANTHROPIC_API_KEY to trigger model provider lookup
          await globalThis.services.db
            .update(agentComposeVersions)
            .set({
              content: {
                agents: {
                  "test-compose-invalid-mp": {
                    framework: "claude-code",
                    working_dir: "/home/user/workspace",
                    environment: {},
                  },
                },
              },
            })
            .where(eq(agentComposeVersions.id, composeData.versionId));

          // Pass invalid model provider type
          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: composeData.versionId,
              prompt: "test prompt",
              runId: `run-invalid-mp-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
              modelProvider: "non-existent-provider",
            }),
          ).rejects.toThrow(BadRequestError);

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: composeData.versionId,
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

          // Create scope, OpenAI model provider, and claude-code compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(`mp-mismatch-${Date.now()}`);
          createdScopeIds.add(scopeData.id);
          await ctx.createModelProvider("openai-api-key", "test-openai-key");
          const composeData = await ctx.createCompose("test-compose-mismatch", {
            framework: "claude-code", // claude-code agent
          });
          mockClerk({ userId: TEST_USER_ID });

          // Remove auto-created ANTHROPIC_API_KEY to trigger model provider lookup
          await globalThis.services.db
            .update(agentComposeVersions)
            .set({
              content: {
                agents: {
                  "test-compose-mismatch": {
                    framework: "claude-code",
                    working_dir: "/home/user/workspace",
                    environment: {},
                  },
                },
              },
            })
            .where(eq(agentComposeVersions.id, composeData.versionId));

          // Try to use OpenAI provider with claude-code framework
          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: composeData.versionId,
              prompt: "test prompt",
              runId: `run-mismatch-${Date.now()}`,
              sandboxToken: "token",
              userId: testUserId,
              modelProvider: "openai-api-key",
            }),
          ).rejects.toThrow(BadRequestError);

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: composeData.versionId,
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

          // Create scope and model provider via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(
            `mp-auto-inject-${Date.now()}`,
          );
          createdScopeIds.add(scopeData.id);
          await ctx.createModelProvider(
            "claude-code-oauth-token",
            "test-oauth-token-value",
          );
          const composeData = await ctx.createCompose(
            "test-compose-no-env-block",
            {
              framework: "claude-code",
            },
          );
          mockClerk({ userId: TEST_USER_ID });

          // Remove environment block completely (the bug scenario)
          await globalThis.services.db
            .update(agentComposeVersions)
            .set({
              content: {
                agents: {
                  "test-compose-no-env-block": {
                    framework: "claude-code",
                    working_dir: "/home/user/workspace",
                    // NO environment block at all!
                  },
                },
              },
            })
            .where(eq(agentComposeVersions.id, composeData.versionId));

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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

          // Create scope, model provider, and compose via API
          mockClerk({ userId: testUserId });
          const scopeData = await ctx.createScope(
            `mp-precedence-${Date.now()}`,
          );
          createdScopeIds.add(scopeData.id);
          await ctx.createModelProvider(
            "anthropic-api-key",
            "model-provider-key",
          );
          const composeData = await ctx.createCompose(
            "test-compose-user-precedence",
            {
              framework: "claude-code",
              environment: {
                ANTHROPIC_API_KEY: "user-defined-key", // User explicitly sets this
              },
            },
          );
          mockClerk({ userId: TEST_USER_ID });

          const context = await runService.buildExecutionContext({
            agentComposeVersionId: composeData.versionId,
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
