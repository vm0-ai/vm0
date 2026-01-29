import { describe, test, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { calculateSessionHistoryPath, RunService } from "../run-service";
import {
  NotFoundError,
  UnauthorizedError,
  BadRequestError,
  ConcurrentRunLimitError,
} from "../../errors";
import { AgentSessionService } from "../../agent-session/agent-session-service";
import { mockClerk } from "../../../__tests__/clerk-mock";
import { POST as createRunRoute } from "../../../../app/api/agent/runs/route";
import {
  createTestRequest,
  createTestCompose,
  createTestCredential,
  createTestModelProvider,
  failTestRun,
  completeTestRun,
} from "../../../__tests__/api-test-helpers";
import {
  testContext,
  setupUser,
  type UserContext,
} from "../../../__tests__/test-helpers";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

const context = testContext();

describe("run-service", () => {
  // Setup mocks before each test
  beforeEach(() => {
    context.setupMocks();
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
        const runContext = await runService.createRunContext(
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

        expect(runContext.runId).toBe("run-123");
        expect(runContext.agentComposeVersionId).toBe("compose-456");
        expect(runContext.prompt).toBe("test prompt");
        expect(runContext.sandboxToken).toBe("sandbox-token");
        expect(runContext.vars).toEqual({ userId: "user-1" });
        expect(runContext.secrets).toEqual({ apiKey: "secret-123" });
        expect(runContext.userId).toBe("user-1");
        expect(runContext.artifactName).toBe("artifact-name");
        expect(runContext.artifactVersion).toBe("v1");
      });

      test("handles undefined vars and secrets", async () => {
        const runContext = await runService.createRunContext(
          "run-123",
          "compose-456",
          "test prompt",
          "sandbox-token",
          undefined,
          undefined,
          {},
        );

        expect(runContext.vars).toBeUndefined();
        expect(runContext.secrets).toBeUndefined();
      });
    });

    describe("checkConcurrencyLimit", () => {
      /**
       * Helper to create a run via API.
       * API creates runs in "running" status automatically.
       *
       * For status changes:
       * - completed: use completeTestRun(userId, runId) - requires checkpoint
       * - failed: use failTestRun(userId, runId) - via webhook
       * - pending/timeout: direct DB update (system states, no webhook)
       */
      async function createTestRun(
        user: UserContext,
        composeId: string,
      ): Promise<string> {
        mockClerk({ userId: user.userId });
        const request = createTestRequest(
          "http://localhost:3000/api/agent/runs",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentComposeId: composeId,
              prompt: `test prompt ${Date.now()}`,
            }),
          },
        );
        const response = await createRunRoute(request);
        const data = await response.json();
        return data.runId;
      }

      test("passes when no active runs exist for user", async () => {
        const user = await setupUser();
        await expect(
          runService.checkConcurrencyLimit(user.userId, 1),
        ).resolves.toBeUndefined();
      });

      test("skips check entirely when limit is 0 (no limit)", async () => {
        const user = await setupUser();
        const { composeId } = await createTestCompose("test-agent");
        await createTestRun(user, composeId);

        await expect(
          runService.checkConcurrencyLimit(user.userId, 0),
        ).resolves.toBeUndefined();
      });

      test("respects higher limit values", async () => {
        const user = await setupUser();
        const { composeId } = await createTestCompose("test-agent");
        await createTestRun(user, composeId);

        await expect(
          runService.checkConcurrencyLimit(user.userId, 100),
        ).resolves.toBeUndefined();
      });

      test("throws ConcurrentRunLimitError when active runs >= limit", async () => {
        const user = await setupUser();
        const { composeId } = await createTestCompose("test-agent");
        await createTestRun(user, composeId);

        await expect(
          runService.checkConcurrencyLimit(user.userId, 1),
        ).rejects.toThrow(ConcurrentRunLimitError);
      });

      test("throws ConcurrentRunLimitError when active runs exceed limit", async () => {
        const user = await setupUser();
        const { composeId } = await createTestCompose("test-agent");
        // Create two running runs to exceed limit of 1
        await createTestRun(user, composeId);
        await createTestRun(user, composeId);

        await expect(
          runService.checkConcurrencyLimit(user.userId, 1),
        ).rejects.toThrow(ConcurrentRunLimitError);
      });

      test("passes when active runs below limit", async () => {
        const user = await setupUser();
        const { composeId } = await createTestCompose("test-agent");
        await createTestRun(user, composeId);

        await expect(
          runService.checkConcurrencyLimit(user.userId, 3),
        ).resolves.toBeUndefined();
      });

      test("only counts pending and running statuses", async () => {
        const user = await setupUser();
        const { composeId } = await createTestCompose("test-agent");

        // Create runs and transition to non-active statuses via webhooks
        const completedRunId = await createTestRun(user, composeId);
        await completeTestRun(user.userId, completedRunId);

        const failedRunId = await createTestRun(user, composeId);
        await failTestRun(user.userId, failedRunId);

        // None of completed/failed should count toward limit
        await expect(
          runService.checkConcurrencyLimit(user.userId, 1),
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
        const user = await setupUser();
        vi.stubEnv("CONCURRENT_RUN_LIMIT", "invalid");

        try {
          await expect(
            runService.checkConcurrencyLimit(user.userId),
          ).resolves.toBeUndefined();
        } finally {
          vi.unstubAllEnvs();
        }
      });
    });

    describe("buildExecutionContext", () => {
      describe("new run mode", () => {
        test("builds context for new run with real database", async () => {
          const user = await setupUser();
          const { versionId } = await createTestCompose("test-agent", {
            working_dir: "/workspace",
            environment: { ANTHROPIC_API_KEY: "test-key" },
          });

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: "run-123",
            sandboxToken: "token",
            userId: user.userId,
            artifactName: "artifact-1",
            artifactVersion: "v1",
            vars: { foo: "bar" },
            volumeVersions: { vol1: "version1" },
          });

          expect(execContext.runId).toBe("run-123");
          expect(execContext.agentComposeVersionId).toBe(versionId);
          expect(execContext.prompt).toBe("test prompt");
          expect(execContext.artifactName).toBe("artifact-1");
          expect(execContext.artifactVersion).toBe("v1");
          expect(execContext.vars).toEqual({ foo: "bar" });
          expect(execContext.volumeVersions).toEqual({ vol1: "version1" });
          expect(execContext.resumeSession).toBeUndefined();
          expect(execContext.resumeArtifact).toBeUndefined();
        });

        test("throws NotFoundError when compose not found", async () => {
          const user = await setupUser();

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: "non-existent-uuid",
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: user.userId,
            }),
          ).rejects.toThrow(NotFoundError);
        });

        test("throws NotFoundError when no agentComposeVersionId provided for new run", async () => {
          const user = await setupUser();

          await expect(
            runService.buildExecutionContext({
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: user.userId,
            }),
          ).rejects.toThrow(NotFoundError);
        });
      });

      describe("session continue mode", () => {
        const agentSessionService = new AgentSessionService();

        test("throws NotFoundError when session not found", async () => {
          const user = await setupUser();

          await expect(
            runService.buildExecutionContext({
              sessionId: randomUUID(),
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: user.userId,
            }),
          ).rejects.toThrow(NotFoundError);
        });

        test("throws UnauthorizedError when session belongs to different user", async () => {
          // Create two users
          const user1 = await setupUser({ prefix: "user1" });
          const user2 = await setupUser({ prefix: "user2" });

          // Create compose and session for user1
          const { composeId, versionId } =
            await createTestCompose("test-agent");
          const session = await agentSessionService.create({
            userId: user1.userId,
            agentComposeId: composeId,
            agentComposeVersionId: versionId,
            artifactName: "test-artifact",
          });

          // Try to access session as user2
          await expect(
            runService.buildExecutionContext({
              sessionId: session.id,
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: user2.userId,
            }),
          ).rejects.toThrow(UnauthorizedError);
        });

        test("throws NotFoundError when session has no conversation", async () => {
          const user = await setupUser();
          const { composeId, versionId } =
            await createTestCompose("test-agent");

          const session = await agentSessionService.create({
            userId: user.userId,
            agentComposeId: composeId,
            agentComposeVersionId: versionId,
            artifactName: "test-artifact-no-conversation",
          });

          await expect(
            runService.buildExecutionContext({
              sessionId: session.id,
              prompt: "test",
              runId: "run-123",
              sandboxToken: "token",
              userId: user.userId,
            }),
          ).rejects.toThrow(NotFoundError);
        });
      });

      describe("credential merging into secrets", () => {
        test("merges credentials into secrets for masking", async () => {
          const user = await setupUser();
          await createTestCredential(
            "MY_CREDENTIAL",
            "credential-secret-value",
          );
          const { versionId } = await createTestCompose(
            "test-compose-credential-merge",
            {
              environment: {
                ANTHROPIC_API_KEY: "test-api-key",
                MY_CRED: "${{ credentials.MY_CREDENTIAL }}",
              },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
          });

          expect(execContext.secrets).toEqual({
            MY_CREDENTIAL: "credential-secret-value",
          });
        });

        test("CLI secrets take priority over credentials on collision", async () => {
          const user = await setupUser();
          await createTestCredential("API_KEY", "credential-value");
          const { versionId } = await createTestCompose(
            "test-compose-priority",
            {
              environment: {
                ANTHROPIC_API_KEY: "test-api-key",
                API_KEY: "${{ credentials.API_KEY }}",
              },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
            secrets: { API_KEY: "cli-secret-value" },
          });

          expect(execContext.secrets).toEqual({
            API_KEY: "cli-secret-value",
          });
        });

        test("merges multiple credentials with multiple CLI secrets", async () => {
          const user = await setupUser();
          await createTestCredential("CRED_A", "cred-a-value");
          await createTestCredential("CRED_B", "cred-b-value");
          const { versionId } = await createTestCompose("test-compose-multi", {
            environment: {
              ANTHROPIC_API_KEY: "test-api-key",
              CRED_A: "${{ credentials.CRED_A }}",
              CRED_B: "${{ credentials.CRED_B }}",
            },
          });

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
            secrets: {
              CRED_B: "cli-b-value",
              CLI_SECRET: "cli-only-value",
            },
          });

          expect(execContext.secrets).toEqual({
            CRED_A: "cred-a-value",
            CRED_B: "cli-b-value",
            CLI_SECRET: "cli-only-value",
          });
        });
      });

      describe("model provider credential injection", () => {
        test("skips injection when compose has explicit ANTHROPIC_API_KEY", async () => {
          const user = await setupUser();
          const { versionId } = await createTestCompose(
            "test-compose-explicit-anthropic",
            {
              framework: "claude-code",
              environment: { ANTHROPIC_API_KEY: "explicit-api-key-value" },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
          });

          expect(execContext.secrets).toBeUndefined();
        });

        test("skips injection when compose has explicit OPENAI_API_KEY", async () => {
          const user = await setupUser();
          const { versionId } = await createTestCompose(
            "test-compose-explicit-openai",
            {
              framework: "codex",
              environment: { OPENAI_API_KEY: "explicit-openai-key" },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
          });

          expect(execContext.secrets).toBeUndefined();
        });

        test("skips injection when compose has alternative auth method (CLAUDE_CODE_USE_FOUNDRY)", async () => {
          const user = await setupUser();
          const { versionId } = await createTestCompose(
            "test-compose-foundry",
            {
              framework: "claude-code",
              environment: { CLAUDE_CODE_USE_FOUNDRY: "1" },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
          });

          expect(execContext.secrets).toBeUndefined();
        });

        test("uses specified model provider when --model-provider is passed", async () => {
          const user = await setupUser();
          await createTestModelProvider(
            "anthropic-api-key",
            "test-anthropic-api-key-value",
          );
          const { versionId } = await createTestCompose(
            "test-compose-no-mp-config",
            {
              framework: "claude-code",
              environment: { SOME_VAR: "some-value" },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
            modelProvider: "anthropic-api-key",
          });

          expect(execContext.secrets).toEqual({
            ANTHROPIC_API_KEY: "test-anthropic-api-key-value",
          });
        });

        test("uses default model provider when no explicit config", async () => {
          const user = await setupUser();
          await createTestModelProvider(
            "anthropic-api-key",
            "default-provider-key-value",
          );
          const { versionId } = await createTestCompose(
            "test-compose-default-mp",
            {
              skipDefaultApiKey: true,
              overrides: { framework: "claude-code" },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
          });

          expect(execContext.secrets).toEqual({
            ANTHROPIC_API_KEY: "default-provider-key-value",
          });
        });

        test("throws BadRequestError when no model provider configured", async () => {
          const user = await setupUser();
          const { versionId } = await createTestCompose("test-compose-no-mp", {
            skipDefaultApiKey: true,
            overrides: { framework: "claude-code" },
          });

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-${Date.now()}`,
              sandboxToken: "token",
              userId: user.userId,
            }),
          ).rejects.toThrow(BadRequestError);

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-${Date.now()}-2`,
              sandboxToken: "token",
              userId: user.userId,
            }),
          ).rejects.toThrow(/No model provider configured/);
        });

        test("throws BadRequestError when model provider type is invalid", async () => {
          const user = await setupUser();
          const { versionId } = await createTestCompose(
            "test-compose-invalid-mp",
            {
              skipDefaultApiKey: true,
              overrides: { framework: "claude-code" },
            },
          );

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-${Date.now()}`,
              sandboxToken: "token",
              userId: user.userId,
              modelProvider: "non-existent-provider",
            }),
          ).rejects.toThrow(BadRequestError);

          await expect(
            runService.buildExecutionContext({
              agentComposeVersionId: versionId,
              prompt: "test prompt",
              runId: `run-${Date.now()}-2`,
              sandboxToken: "token",
              userId: user.userId,
              modelProvider: "non-existent-provider",
            }),
          ).rejects.toThrow(/Unknown model provider type/);
        });

        test("auto-injects model provider credential into environment when no environment block exists", async () => {
          const user = await setupUser();
          await createTestModelProvider(
            "claude-code-oauth-token",
            "test-oauth-token-value",
          );
          const { versionId } = await createTestCompose(
            "test-compose-no-env-block",
            {
              noEnvironmentBlock: true,
              overrides: { framework: "claude-code" },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
          });

          expect(execContext.environment).toBeDefined();
          expect(execContext.environment!["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(
            "test-oauth-token-value",
          );
          expect(execContext.secrets).toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token-value",
          });
        });

        test("user-defined environment takes precedence over auto-injected credential", async () => {
          const user = await setupUser();
          await createTestModelProvider(
            "anthropic-api-key",
            "model-provider-key",
          );
          const { versionId } = await createTestCompose(
            "test-compose-user-precedence",
            {
              framework: "claude-code",
              environment: {
                ANTHROPIC_API_KEY: "user-defined-key",
              },
            },
          );

          const execContext = await runService.buildExecutionContext({
            agentComposeVersionId: versionId,
            prompt: "test prompt",
            runId: `run-${Date.now()}`,
            sandboxToken: "token",
            userId: user.userId,
          });

          expect(execContext.environment!["ANTHROPIC_API_KEY"]).toBe(
            "user-defined-key",
          );
        });
      });
    });
  });
});
