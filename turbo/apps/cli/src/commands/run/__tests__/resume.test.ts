/**
 * Tests for run resume command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { resumeCommand } from "../resume";
import chalk from "chalk";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";

describe("run resume command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testCheckpointId = "550e8400-e29b-41d4-a716-446655440000";

  // Default checkpoint response
  const defaultCheckpointResponse = {
    id: testCheckpointId,
    agentComposeSnapshot: {
      secretNames: ["API_KEY"],
    },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  // Default run response
  const defaultRunResponse = {
    runId: "run-123",
    status: "running",
    sandboxId: "sbx-456",
    createdAt: "2025-01-01T00:00:00Z",
  };

  // Default events response with completed status
  const defaultEventsResponse = {
    events: [],
    hasMore: false,
    nextSequence: 0,
    run: {
      status: "completed",
      result: {
        checkpointId: "cp-new-123",
        agentSessionId: "session-123",
        conversationId: "conv-123",
        artifact: {},
      },
    },
    framework: "claude-code",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Default handlers
    server.use(
      http.get("http://localhost:3000/api/agent/checkpoints/:id", () => {
        return HttpResponse.json(defaultCheckpointResponse);
      }),
      http.post("http://localhost:3000/api/agent/runs", () => {
        return HttpResponse.json(defaultRunResponse, { status: 201 });
      }),
      http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
        return HttpResponse.json(defaultEventsResponse);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("successful resume", () => {
    it("should resume from checkpoint with prompt", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await resumeCommand.parseAsync([
        "node",
        "cli",
        testCheckpointId,
        "Resume from where we left off",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          checkpointId: testCheckpointId,
          prompt: "Resume from where we left off",
        }),
      );

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("run-123");
    });

    it("should pass vars and secrets to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await resumeCommand.parseAsync([
        "node",
        "cli",
        testCheckpointId,
        "test prompt",
        "--vars",
        "KEY1=value1",
        "--secrets",
        "SECRET1=secret-value",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          checkpointId: testCheckpointId,
          vars: { KEY1: "value1" },
          secrets: { SECRET1: "secret-value" },
        }),
      );
    });

    it("should pass volume versions to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await resumeCommand.parseAsync([
        "node",
        "cli",
        testCheckpointId,
        "test prompt",
        "--volume-version",
        "data=v1.0.0",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          volumeVersions: { data: "v1.0.0" },
        }),
      );
    });

    it("should pass model provider option to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await resumeCommand.parseAsync([
        "node",
        "cli",
        testCheckpointId,
        "test prompt",
        "--model-provider",
        "anthropic-api-key",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          modelProvider: "anthropic-api-key",
        }),
      );
    });
  });

  describe("checkpoint ID validation", () => {
    it("should reject invalid checkpoint ID format", async () => {
      await expect(async () => {
        await resumeCommand.parseAsync([
          "node",
          "cli",
          "invalid-checkpoint-id",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid checkpoint ID format"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must be a valid UUID"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should accept valid UUID format", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await resumeCommand.parseAsync([
        "node",
        "cli",
        testCheckpointId,
        "test prompt",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          checkpointId: testCheckpointId,
        }),
      );
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/checkpoints/:id", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED",
              },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await resumeCommand.parseAsync([
          "node",
          "cli",
          testCheckpointId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle checkpoint not found error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/checkpoints/:id", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Checkpoint not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await resumeCommand.parseAsync([
          "node",
          "cli",
          testCheckpointId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Checkpoint not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle run preparation failure", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-failed",
              status: "failed",
              error: "Missing required secrets",
            },
            { status: 201 },
          );
        }),
      );

      await expect(async () => {
        await resumeCommand.parseAsync([
          "node",
          "cli",
          testCheckpointId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run preparation failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing required secrets"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle concurrent run limit error", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json(
            {
              error: {
                message: "You have reached the concurrent agent run limit.",
                code: "concurrent_run_limit_exceeded",
              },
            },
            { status: 429 },
          );
        }),
      );

      await expect(async () => {
        await resumeCommand.parseAsync([
          "node",
          "cli",
          testCheckpointId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Resume failed"),
      );

      const allErrors = mockConsoleError.mock.calls
        .map((call) => call[0])
        .filter((err): err is string => typeof err === "string");

      expect(
        allErrors.some((err) => err.includes("concurrent agent run limit")),
      ).toBe(true);
      expect(allErrors.some((err) => err.includes("vm0 run list"))).toBe(true);
      expect(allErrors.some((err) => err.includes("vm0 run kill"))).toBe(true);
    });
  });

  describe("--env-file option", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(path.join(os.tmpdir(), "test-resume-env-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("should load secrets from env file", async () => {
      const envFilePath = path.join(tempDir, ".env");
      writeFileSync(envFilePath, "API_KEY=secret-from-file");

      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await resumeCommand.parseAsync([
        "node",
        "cli",
        testCheckpointId,
        "test prompt",
        "--env-file",
        envFilePath,
      ]);

      expect(capturedBody?.secrets).toEqual({ API_KEY: "secret-from-file" });
    });

    it("should error when env file not found", async () => {
      await expect(async () => {
        await resumeCommand.parseAsync([
          "node",
          "cli",
          testCheckpointId,
          "test prompt",
          "--env-file",
          "/nonexistent/path/.env",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Environment file not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should prioritize CLI secrets over env file", async () => {
      const envFilePath = path.join(tempDir, ".env");
      writeFileSync(envFilePath, "API_KEY=from-file");

      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/agent/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultRunResponse, { status: 201 });
          },
        ),
      );

      await resumeCommand.parseAsync([
        "node",
        "cli",
        testCheckpointId,
        "test prompt",
        "--secrets",
        "API_KEY=from-cli",
        "--env-file",
        envFilePath,
      ]);

      expect(capturedBody?.secrets).toEqual({ API_KEY: "from-cli" });
    });
  });

  describe("run failure handling", () => {
    it("should exit with error when run fails", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: { status: "failed", error: "Agent crashed" },
            framework: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await resumeCommand.parseAsync([
          "node",
          "cli",
          testCheckpointId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error when run times out", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextSequence: 0,
            run: { status: "timeout" },
            framework: "claude-code",
          });
        }),
      );

      await expect(async () => {
        await resumeCommand.parseAsync([
          "node",
          "cli",
          testCheckpointId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run timed out"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("next steps output", () => {
    it("should show next steps after successful completion", async () => {
      await resumeCommand.parseAsync([
        "node",
        "cli",
        testCheckpointId,
        "test prompt",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      // Should show logs command
      expect(logCalls).toContain("vm0 logs");
      // Should show continue command with new session
      expect(logCalls).toContain("vm0 run continue");
      expect(logCalls).toContain("session-123");
      // Should show resume command with new checkpoint
      expect(logCalls).toContain("vm0 run resume");
      expect(logCalls).toContain("cp-new-123");
    });
  });
});
