import { describe, test, expect, vi, beforeEach } from "vitest";

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

import { calculateSessionHistoryPath, RunService } from "../run-service";
import { NotFoundError, UnauthorizedError } from "../../errors";
import { agentSessionService } from "../../agent-session";

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
  let runService: RunService;

  beforeEach(() => {
    runService = new RunService();
    vi.clearAllMocks();
  });

  describe("createRunContext", () => {
    test("creates basic execution context", async () => {
      const context = await runService.createRunContext(
        "run-123",
        "config-456",
        "test prompt",
        "sandbox-token",
        { userId: "user-1" },
        { agents: { "test-agent": { working_dir: "/workspace" } } },
        "user-1",
        "artifact-name",
        "v1",
      );

      expect(context.runId).toBe("run-123");
      expect(context.agentConfigId).toBe("config-456");
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
        "config-456",
        "test prompt",
        "sandbox-token",
        undefined,
        {},
      );

      expect(context.templateVars).toBeUndefined();
    });
  });

  describe("buildExecutionContext", () => {
    const mockDbSelect = vi.fn();

    beforeEach(() => {
      mockDbSelect.mockReset();
      // Setup minimal globalThis.services mock
      globalThis.services = {
        db: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: mockDbSelect,
              }),
            }),
          }),
        },
      } as unknown as typeof globalThis.services;
    });

    describe("new run mode", () => {
      test("builds context for new run with agentConfigId", async () => {
        const mockConfig = {
          id: "config-123",
          config: { agents: { "test-agent": { working_dir: "/workspace" } } },
        };

        mockDbSelect.mockResolvedValueOnce([mockConfig]);

        const context = await runService.buildExecutionContext({
          agentConfigId: "config-123",
          prompt: "test prompt",
          runId: "run-123",
          sandboxToken: "token",
          userId: "user-1",
          artifactName: "artifact-1",
          artifactVersion: "v1",
          templateVars: { foo: "bar" },
          volumeVersions: { vol1: "version1" },
        });

        expect(context.runId).toBe("run-123");
        expect(context.agentConfigId).toBe("config-123");
        expect(context.prompt).toBe("test prompt");
        expect(context.artifactName).toBe("artifact-1");
        expect(context.artifactVersion).toBe("v1");
        expect(context.templateVars).toEqual({ foo: "bar" });
        expect(context.volumeVersions).toEqual({ vol1: "version1" });
        expect(context.resumeSession).toBeUndefined();
        expect(context.resumeArtifact).toBeUndefined();
      });

      test("throws NotFoundError when config not found", async () => {
        mockDbSelect.mockResolvedValueOnce([]);

        await expect(
          runService.buildExecutionContext({
            agentConfigId: "non-existent",
            prompt: "test",
            runId: "run-123",
            sandboxToken: "token",
            userId: "user-1",
          }),
        ).rejects.toThrow(NotFoundError);
      });

      test("throws NotFoundError when no agentConfigId provided for new run", async () => {
        await expect(
          runService.buildExecutionContext({
            prompt: "test",
            runId: "run-123",
            sandboxToken: "token",
            userId: "user-1",
          }),
        ).rejects.toThrow(NotFoundError);
      });
    });

    describe("checkpoint resume mode", () => {
      const mockCheckpoint = {
        id: "checkpoint-123",
        runId: "original-run-123",
        conversationId: "conv-123",
        agentConfigSnapshot: {
          config: { agents: { "test-agent": { working_dir: "/workspace" } } },
          templateVars: { existing: "var" },
        },
        artifactSnapshot: {
          artifactName: "snapshot-artifact",
          artifactVersion: "snapshot-v1",
        },
        volumeVersionsSnapshot: {
          versions: { snapshotVol: "snapshotVersion" },
        },
      };

      const mockOriginalRun = {
        id: "original-run-123",
        userId: "user-1",
        agentConfigId: "config-123",
      };

      const mockConversation = {
        id: "conv-123",
        cliAgentSessionId: "session-456",
        cliAgentSessionHistory: '{"event":"init"}',
      };

      test("builds context from checkpoint with all snapshots", async () => {
        mockDbSelect
          .mockResolvedValueOnce([mockCheckpoint])
          .mockResolvedValueOnce([mockOriginalRun])
          .mockResolvedValueOnce([mockConversation]);

        const context = await runService.buildExecutionContext({
          checkpointId: "checkpoint-123",
          prompt: "new prompt",
          runId: "run-new",
          sandboxToken: "token",
          userId: "user-1",
        });

        expect(context.runId).toBe("run-new");
        expect(context.agentConfigId).toBe("config-123");
        expect(context.prompt).toBe("new prompt");
        expect(context.artifactName).toBe("snapshot-artifact");
        expect(context.artifactVersion).toBe("snapshot-v1");
        expect(context.templateVars).toEqual({ existing: "var" });
        expect(context.volumeVersions).toEqual({
          snapshotVol: "snapshotVersion",
        });
        expect(context.resumeSession).toEqual({
          sessionId: "session-456",
          sessionHistory: '{"event":"init"}',
          workingDir: "/workspace",
        });
        expect(context.resumeArtifact).toEqual({
          artifactName: "snapshot-artifact",
          artifactVersion: "snapshot-v1",
        });
      });

      test("allows explicit volumeVersions to override checkpoint snapshot", async () => {
        mockDbSelect
          .mockResolvedValueOnce([mockCheckpoint])
          .mockResolvedValueOnce([mockOriginalRun])
          .mockResolvedValueOnce([mockConversation]);

        const context = await runService.buildExecutionContext({
          checkpointId: "checkpoint-123",
          prompt: "new prompt",
          runId: "run-new",
          sandboxToken: "token",
          userId: "user-1",
          volumeVersions: { overrideVol: "overrideVersion" },
        });

        expect(context.volumeVersions).toEqual({
          overrideVol: "overrideVersion",
        });
      });

      test("throws NotFoundError when checkpoint not found", async () => {
        mockDbSelect.mockResolvedValueOnce([]);

        await expect(
          runService.buildExecutionContext({
            checkpointId: "non-existent",
            prompt: "test",
            runId: "run-123",
            sandboxToken: "token",
            userId: "user-1",
          }),
        ).rejects.toThrow(NotFoundError);
      });

      test("throws UnauthorizedError when checkpoint belongs to different user", async () => {
        mockDbSelect
          .mockResolvedValueOnce([mockCheckpoint])
          .mockResolvedValueOnce([]); // No run found for this user

        await expect(
          runService.buildExecutionContext({
            checkpointId: "checkpoint-123",
            prompt: "test",
            runId: "run-123",
            sandboxToken: "token",
            userId: "wrong-user",
          }),
        ).rejects.toThrow(UnauthorizedError);
      });

      test("throws NotFoundError when conversation not found", async () => {
        mockDbSelect
          .mockResolvedValueOnce([mockCheckpoint])
          .mockResolvedValueOnce([mockOriginalRun])
          .mockResolvedValueOnce([]); // No conversation found

        await expect(
          runService.buildExecutionContext({
            checkpointId: "checkpoint-123",
            prompt: "test",
            runId: "run-123",
            sandboxToken: "token",
            userId: "user-1",
          }),
        ).rejects.toThrow(NotFoundError);
      });
    });

    describe("session continue mode", () => {
      test("uses 'latest' as default artifact version for session continue", async () => {
        const mockSession = {
          id: "session-123",
          userId: "user-1",
          agentConfigId: "config-123",
          artifactName: "session-artifact",
          templateVars: { session: "var" },
          conversationId: "conv-123",
          conversation: {
            cliAgentSessionId: "cli-session-456",
            cliAgentSessionHistory: '{"event":"test"}',
          },
        };

        const mockConfig = {
          id: "config-123",
          config: { agents: { "test-agent": { working_dir: "/workspace" } } },
        };

        vi.mocked(
          agentSessionService.getByIdWithConversation,
        ).mockResolvedValueOnce(mockSession as never);
        mockDbSelect.mockResolvedValueOnce([mockConfig]);

        const context = await runService.buildExecutionContext({
          sessionId: "session-123",
          prompt: "continue prompt",
          runId: "run-new",
          sandboxToken: "token",
          userId: "user-1",
        });

        expect(context.artifactVersion).toBe("latest");
        expect(context.resumeArtifact?.artifactVersion).toBe("latest");
      });

      test("allows explicit volumeVersions for session continue", async () => {
        const mockSession = {
          id: "session-123",
          userId: "user-1",
          agentConfigId: "config-123",
          artifactName: "session-artifact",
          templateVars: null,
          conversationId: "conv-123",
          conversation: {
            cliAgentSessionId: "cli-session-456",
            cliAgentSessionHistory: "{}",
          },
        };

        const mockConfig = {
          id: "config-123",
          config: { agents: { "test-agent": { working_dir: "/workspace" } } },
        };

        vi.mocked(
          agentSessionService.getByIdWithConversation,
        ).mockResolvedValueOnce(mockSession as never);
        mockDbSelect.mockResolvedValueOnce([mockConfig]);

        const context = await runService.buildExecutionContext({
          sessionId: "session-123",
          prompt: "continue prompt",
          runId: "run-new",
          sandboxToken: "token",
          userId: "user-1",
          volumeVersions: { myVol: "myVersion" },
        });

        expect(context.volumeVersions).toEqual({ myVol: "myVersion" });
      });

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
            userId: "user-1",
          }),
        ).rejects.toThrow(NotFoundError);
      });

      test("throws UnauthorizedError when session belongs to different user", async () => {
        const mockSession = {
          id: "session-123",
          userId: "different-user",
          agentConfigId: "config-123",
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
            userId: "user-1",
          }),
        ).rejects.toThrow(UnauthorizedError);
      });

      test("throws NotFoundError when session has no conversation", async () => {
        const mockSession = {
          id: "session-123",
          userId: "user-1",
          agentConfigId: "config-123",
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
            userId: "user-1",
          }),
        ).rejects.toThrow(NotFoundError);
      });
    });

    describe("direct conversation mode", () => {
      const mockConversation = {
        id: "conv-123",
        runId: "original-run-123",
        cliAgentSessionId: "cli-session-456",
        cliAgentSessionHistory: '{"event":"init"}',
      };

      const mockOriginalRun = {
        id: "original-run-123",
        userId: "user-1",
        agentConfigId: "config-123",
      };

      const mockConfig = {
        id: "config-123",
        config: { agents: { "test-agent": { working_dir: "/workspace" } } },
      };

      test("builds context with resumeSession when conversationId provided directly", async () => {
        mockDbSelect
          .mockResolvedValueOnce([mockConversation])
          .mockResolvedValueOnce([mockOriginalRun])
          .mockResolvedValueOnce([mockConfig]);

        const context = await runService.buildExecutionContext({
          agentConfigId: "config-123",
          conversationId: "conv-123",
          prompt: "continue prompt",
          runId: "run-new",
          sandboxToken: "token",
          userId: "user-1",
          artifactName: "artifact-1",
          artifactVersion: "v1",
        });

        expect(context.runId).toBe("run-new");
        expect(context.agentConfigId).toBe("config-123");
        expect(context.prompt).toBe("continue prompt");
        expect(context.artifactName).toBe("artifact-1");
        expect(context.artifactVersion).toBe("v1");
        expect(context.resumeSession).toEqual({
          sessionId: "cli-session-456",
          sessionHistory: '{"event":"init"}',
          workingDir: "/workspace",
        });
      });

      test("throws NotFoundError when conversation not found", async () => {
        mockDbSelect.mockResolvedValueOnce([]);

        await expect(
          runService.buildExecutionContext({
            agentConfigId: "config-123",
            conversationId: "non-existent",
            prompt: "test",
            runId: "run-123",
            sandboxToken: "token",
            userId: "user-1",
          }),
        ).rejects.toThrow(NotFoundError);
      });

      test("throws UnauthorizedError when conversation belongs to different user", async () => {
        mockDbSelect
          .mockResolvedValueOnce([mockConversation])
          .mockResolvedValueOnce([]); // No run found for this user

        await expect(
          runService.buildExecutionContext({
            agentConfigId: "config-123",
            conversationId: "conv-123",
            prompt: "test",
            runId: "run-123",
            sandboxToken: "token",
            userId: "wrong-user",
          }),
        ).rejects.toThrow(UnauthorizedError);
      });

      test("throws NotFoundError when agentConfig not found with conversationId", async () => {
        mockDbSelect
          .mockResolvedValueOnce([mockConversation])
          .mockResolvedValueOnce([mockOriginalRun])
          .mockResolvedValueOnce([]); // No config found

        await expect(
          runService.buildExecutionContext({
            agentConfigId: "non-existent-config",
            conversationId: "conv-123",
            prompt: "test",
            runId: "run-123",
            sandboxToken: "token",
            userId: "user-1",
          }),
        ).rejects.toThrow(NotFoundError);
      });

      test("uses default workingDir when config has no agents", async () => {
        const configWithoutAgents = {
          id: "config-123",
          config: {},
        };

        mockDbSelect
          .mockResolvedValueOnce([mockConversation])
          .mockResolvedValueOnce([mockOriginalRun])
          .mockResolvedValueOnce([configWithoutAgents]);

        const context = await runService.buildExecutionContext({
          agentConfigId: "config-123",
          conversationId: "conv-123",
          prompt: "test",
          runId: "run-new",
          sandboxToken: "token",
          userId: "user-1",
        });

        expect(context.resumeSession?.workingDir).toBe("/workspace");
      });
    });
  });
});
