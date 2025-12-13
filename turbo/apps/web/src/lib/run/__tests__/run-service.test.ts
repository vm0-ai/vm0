/**
 * @vitest-environment node
 */
import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
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

// Mock e2b-service to prevent env() access during module load
vi.mock("../../e2b", () => ({
  e2bService: {
    execute: vi.fn(),
  },
}));

// Mock agent-session service
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
let agentSessionService: typeof import("../../agent-session").agentSessionService;

// Test user ID for isolation
const TEST_USER_ID = "test-user-run-service";

describe("run-service", () => {
  beforeAll(async () => {
    initServices();
    const runServiceModule = await import("../run-service");
    calculateSessionHistoryPath = runServiceModule.calculateSessionHistoryPath;
    RunService = runServiceModule.RunService;

    const errorsModule = await import("../../errors");
    NotFoundError = errorsModule.NotFoundError;
    UnauthorizedError = errorsModule.UnauthorizedError;

    const agentSessionModule = await import("../../agent-session");
    agentSessionService = agentSessionModule.agentSessionService;
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
        "/home/user/.config/claude/projects/-workspace/session-123.jsonl",
      );
    });

    test("handles nested path", () => {
      const result = calculateSessionHistoryPath(
        "/home/user/projects/myapp",
        "session-456",
      );
      expect(result).toBe(
        "/home/user/.config/claude/projects/-home-user-projects-myapp/session-456.jsonl",
      );
    });

    test("handles path with multiple leading slashes", () => {
      const result = calculateSessionHistoryPath("/test/path", "abc");
      expect(result).toBe(
        "/home/user/.config/claude/projects/-test-path/abc.jsonl",
      );
    });

    test("handles single directory path", () => {
      const result = calculateSessionHistoryPath("/myproject", "xyz");
      expect(result).toBe(
        "/home/user/.config/claude/projects/-myproject/xyz.jsonl",
      );
    });

    test("preserves session ID exactly", () => {
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      const result = calculateSessionHistoryPath("/workspace", sessionId);
      expect(result).toContain(sessionId);
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
          { agents: { "test-agent": { working_dir: "/workspace" } } },
          "user-1",
          "artifact-name",
          "v1",
        );

        expect(context.runId).toBe("run-123");
        expect(context.agentComposeVersionId).toBe("compose-456");
        expect(context.prompt).toBe("test prompt");
        expect(context.sandboxToken).toBe("sandbox-token");
        expect(context.templateVars).toEqual({ userId: "user-1" });
        expect(context.userId).toBe("user-1");
        expect(context.artifactName).toBe("artifact-name");
        expect(context.artifactVersion).toBe("v1");
      });

      test("handles undefined template vars", async () => {
        const context = await runService.createRunContext(
          "run-123",
          "compose-456",
          "test prompt",
          "sandbox-token",
          undefined,
          {},
        );

        expect(context.templateVars).toBeUndefined();
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
              name: "test-compose-run-service",
            })
            .returning();

          const versionId = "test-version-sha-for-run-service-test-123";
          await globalThis.services.db.insert(agentComposeVersions).values({
            id: versionId,
            composeId: compose!.id,
            content: {
              agents: { "test-agent": { working_dir: "/workspace" } },
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
            templateVars: { foo: "bar" },
            volumeVersions: { vol1: "version1" },
          });

          expect(context.runId).toBe("run-123");
          expect(context.agentComposeVersionId).toBe(versionId);
          expect(context.prompt).toBe("test prompt");
          expect(context.artifactName).toBe("artifact-1");
          expect(context.artifactVersion).toBe("v1");
          expect(context.templateVars).toEqual({ foo: "bar" });
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
    });
  });
});
