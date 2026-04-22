/**
 * Tests for zero voice-chat task create command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { voiceChatTaskCreateCommand } from "../task/create";

const TASKS_URL = "http://localhost:3000/api/zero/voice-chat/:id/tasks";

describe("zero voice-chat task create command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  describe("successful create", () => {
    it("should POST prompt and print the created task", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const createdTask = {
        id: "00000000-0000-0000-0000-000000000001",
        sessionId: "00000000-0000-0000-0000-00000000aaaa",
        runId: null,
        prompt: "Summarize the PR",
        status: "pending",
        result: null,
        error: null,
        assistantMessages: [],
        createdAt: "2026-04-22T00:00:00Z",
        startedAt: null,
        finishedAt: null,
      };

      server.use(
        http.post(TASKS_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ task: createdTask }, { status: 200 });
        }),
      );

      await voiceChatTaskCreateCommand.parseAsync([
        "node",
        "cli",
        "00000000-0000-0000-0000-00000000aaaa",
        "--prompt",
        "Summarize the PR",
      ]);

      expect(capturedBody).toEqual({ prompt: "Summarize the PR" });
      expect(mockConsoleLog).toHaveBeenCalledWith(
        JSON.stringify(createdTask, null, 2),
      );
    });
  });

  describe("missing --prompt", () => {
    it("should exit non-zero when --prompt is not provided", async () => {
      await expect(async () => {
        await voiceChatTaskCreateCommand.parseAsync([
          "node",
          "cli",
          "00000000-0000-0000-0000-00000000aaaa",
        ]);
      }).rejects.toThrow("process.exit called");
    });
  });

  describe("API errors", () => {
    it("should handle 404 session not found", async () => {
      server.use(
        http.post(TASKS_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Voice-chat session not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await voiceChatTaskCreateCommand.parseAsync([
          "node",
          "cli",
          "00000000-0000-0000-0000-00000000aaaa",
          "--prompt",
          "Summarize the PR",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Voice-chat session not found"),
      );
    });

    it("should handle 401 unauthorized", async () => {
      server.use(
        http.post(TASKS_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await voiceChatTaskCreateCommand.parseAsync([
          "node",
          "cli",
          "00000000-0000-0000-0000-00000000aaaa",
          "--prompt",
          "Summarize the PR",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });
  });
});
