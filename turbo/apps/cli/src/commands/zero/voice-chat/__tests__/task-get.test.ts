/**
 * Tests for zero voice-chat task get command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { voiceChatTaskGetCommand } from "../task/get";

const TASK_URL = "http://localhost:3000/api/zero/voice-chat/:id/tasks/:taskId";

describe("zero voice-chat task get command", () => {
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

  describe("successful get", () => {
    it("should fetch and print the task as JSON", async () => {
      const task = {
        id: "00000000-0000-0000-0000-000000000001",
        sessionId: "00000000-0000-0000-0000-00000000aaaa",
        runId: "00000000-0000-0000-0000-00000000bbbb",
        prompt: "Summarize the PR",
        status: "done",
        result: "PR summary here",
        error: null,
        assistantMessages: [
          {
            type: "assistant",
            content: "PR summary here",
            at: "2026-04-22T00:05:00Z",
          },
        ],
        createdAt: "2026-04-22T00:00:00Z",
        startedAt: "2026-04-22T00:01:00Z",
        finishedAt: "2026-04-22T00:05:00Z",
      };

      server.use(
        http.get(TASK_URL, () => {
          return HttpResponse.json({ task }, { status: 200 });
        }),
      );

      await voiceChatTaskGetCommand.parseAsync([
        "node",
        "cli",
        "00000000-0000-0000-0000-00000000aaaa",
        "00000000-0000-0000-0000-000000000001",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        JSON.stringify(task, null, 2),
      );
    });
  });

  describe("API errors", () => {
    it("should handle 404 task not found", async () => {
      server.use(
        http.get(TASK_URL, () => {
          return HttpResponse.json(
            { error: { message: "Task not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await voiceChatTaskGetCommand.parseAsync([
          "node",
          "cli",
          "00000000-0000-0000-0000-00000000aaaa",
          "00000000-0000-0000-0000-000000000001",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Task not found"),
      );
    });
  });
});
