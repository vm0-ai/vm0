/**
 * Tests for zero run continue command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { continueCommand } from "../continue";
import chalk from "chalk";

describe("zero run continue command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  const testSessionId = "550e8400-e29b-41d4-a716-446655440000";

  const defaultCreateRunResponse = {
    runId: "run-123",
    status: "running",
    sandboxId: "sbx-456",
    createdAt: "2025-01-01T00:00:00Z",
  };

  const defaultGetRunResponse = {
    runId: "run-123",
    agentComposeVersionId: null,
    status: "completed",
    prompt: "test prompt",
    appendSystemPrompt: null,
    result: {
      agentSessionId: testSessionId,
      checkpointId: "cp-123",
    },
    createdAt: "2025-01-01T00:00:00Z",
  };

  const defaultEventsResponse = {
    events: [],
    hasMore: false,
    framework: "claude-code",
  };

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    server.use(
      http.post("http://localhost:3000/api/zero/runs", () => {
        return HttpResponse.json(defaultCreateRunResponse, { status: 201 });
      }),
      http.get("http://localhost:3000/api/zero/runs/:id", () => {
        return HttpResponse.json(defaultGetRunResponse);
      }),
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        () => {
          return HttpResponse.json(defaultEventsResponse);
        },
      ),
    );
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
        expect.stringContaining("Invalid session ID format"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must be a valid UUID"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("successful continue", () => {
    it("should create a zero run with sessionId and poll to completion", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/zero/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultCreateRunResponse, { status: 201 });
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
      // Should not include agentId for continue commands
      expect(capturedBody).not.toHaveProperty("agentId");
    });

    it("should pass append-system-prompt option to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/zero/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultCreateRunResponse, { status: 201 });
          },
        ),
      );

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
        "test prompt",
        "--append-system-prompt",
        "Always respond in JSON",
      ]);

      expect(capturedBody).toEqual(
        expect.objectContaining({
          appendSystemPrompt: "Always respond in JSON",
        }),
      );
    });

    it("should pass model-provider option to API", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      server.use(
        http.post(
          "http://localhost:3000/api/zero/runs",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(defaultCreateRunResponse, { status: 201 });
          },
        ),
      );

      await continueCommand.parseAsync([
        "node",
        "cli",
        testSessionId,
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

  describe("error handling", () => {
    it("should handle run preparation failure", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/runs", () => {
          return HttpResponse.json(
            {
              runId: "run-failed",
              status: "failed",
              error: "Session not found",
              createdAt: "2025-01-01T00:00:00Z",
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
        expect.stringContaining("Session not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle run failure during polling", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/runs/:id", () => {
          return HttpResponse.json({
            ...defaultGetRunResponse,
            status: "failed",
            error: "Agent crashed",
            result: undefined,
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

    it("should handle run cancellation during polling", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/runs/:id", () => {
          return HttpResponse.json({
            ...defaultGetRunResponse,
            status: "cancelled",
            result: undefined,
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
        expect.stringContaining("Run cancelled"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
