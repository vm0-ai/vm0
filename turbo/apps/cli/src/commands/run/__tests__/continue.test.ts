/**
 * Tests for run continue command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { continueCommand } from "../continue";
import chalk from "chalk";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";

describe("run continue command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testSessionId = "550e8400-e29b-41d4-a716-446655440000";

  // Default session response
  const defaultSessionResponse = {
    id: testSessionId,
    agentComposeId: "compose-123",
    secretNames: ["API_KEY"],
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
        checkpointId: "cp-123",
        agentSessionId: testSessionId,
        conversationId: "conv-123",
        artifact: {},
      },
    },
    framework: "claude-code",
  };

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Default handlers
    server.use(
      http.get("http://localhost:3000/api/agent/sessions/:id", () => {
        return HttpResponse.json(defaultSessionResponse);
      }),
      http.post("http://localhost:3000/api/agent/runs", () => {
        return HttpResponse.json(defaultRunResponse, { status: 201 });
      }),
      http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
        return HttpResponse.json(defaultEventsResponse);
      }),
    );
  });

  afterEach(() => {});

  describe("successful continue", () => {
    it("should continue from session with prompt", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "Continue working on the task",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          sessionId: testSessionId,
          prompt: "Continue working on the task",
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--vars",
        "KEY1=value1",
        "--secrets",
        "SECRET1=secret-value",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          sessionId: testSessionId,
          vars: { KEY1: "value1" },
          secrets: { SECRET1: "secret-value" },
        }),
      );
    });

    it("should not send volumeVersions in API request", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
      ]);

      expect(capturedBody).not.toHaveProperty("volumeVersions");
    });

    it("should pass append-system-prompt to API", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--append-system-prompt",
        "Your name is Aria.",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          appendSystemPrompt: "Your name is Aria.",
        }),
      );
    });

    it("should pass disallowed-tools option to API", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--disallowed-tools",
        "CronCreate",
        "WebSearch",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          disallowedTools: ["CronCreate", "WebSearch"],
        }),
      );
    });

    it("should pass tools option to API", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--tools",
        "Bash",
        "Edit",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          tools: ["Bash", "Edit"],
        }),
      );
    });

    it("should pass settings to API", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--settings",
        '{"hooks":{}}',
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          settings: '{"hooks":{}}',
        }),
      );
    });
  });

  describe("--artifact flag", () => {
    it("should send artifacts array when using --artifact with name:/path", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--artifact",
        "my-data:/mnt/data",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          sessionId: testSessionId,
          artifacts: [{ name: "my-data", mountPath: "/mnt/data" }],
        }),
      );
    });

    it("should send artifacts array when using --artifact with name:version:/path", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--artifact",
        "my-data:abc123:/mnt/data",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          sessionId: testSessionId,
          artifacts: [
            { name: "my-data", version: "abc123", mountPath: "/mnt/data" },
          ],
        }),
      );
    });

    it("should send multiple artifacts when --artifact is repeated", async () => {
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--artifact",
        "first:/mnt/first",
        "--artifact",
        "second:v2:/mnt/second",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          artifacts: [
            { name: "first", mountPath: "/mnt/first" },
            { name: "second", version: "v2", mountPath: "/mnt/second" },
          ],
        }),
      );
    });

    it("should reject --artifact without mount path", async () => {
      await expect(async () => {
        await continueCommand.parseAsync([
          "node",
          "cli",
          testSessionId,
          "test prompt",
          "--artifact",
          "my-data",
        ]);
      }).rejects.toThrow();
    });
  });

  describe("session ID validation", () => {
    it("should reject invalid session ID format", async () => {
      await expect(async () => {
        await continueCommand.parseAsync([
          "node",
          "cli",
          "invalid-session-id",
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent session ID format"),
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          sessionId: testSessionId,
        }),
      );
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/sessions/:id", () => {
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
        await continueCommand.parseAsync([
          "node",
          "cli",
          testSessionId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle session not found error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/sessions/:id", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Session not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await continueCommand.parseAsync([
          "node",
          "cli",
          testSessionId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Session not found"),
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
        await continueCommand.parseAsync([
          "node",
          "cli",
          testSessionId,
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
  });

  describe("--env-file option", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(path.join(os.tmpdir(), "test-continue-env-"));
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--env-file",
        envFilePath,
      ]);

      expect(capturedBody?.secrets).toEqual({ API_KEY: "secret-from-file" });
    });

    it("should error when env file not found", async () => {
      await expect(async () => {
        await continueCommand.parseAsync([
          "node",
          "cli",
          testSessionId,
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

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
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
        await continueCommand.parseAsync([
          "node",
          "cli",
          testSessionId,
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
        await continueCommand.parseAsync([
          "node",
          "cli",
          testSessionId,
          "test prompt",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run timed out"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
