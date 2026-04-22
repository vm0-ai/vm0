/**
 * Tests for zero voice-chat task list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { voiceChatTaskListCommand } from "../task/list";

const TASKS_URL = "http://localhost:3000/api/zero/voice-chat/:id/tasks";

describe("zero voice-chat task list command", () => {
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

  describe("successful list", () => {
    it("should print a slim array of {id, status, createdAt}", async () => {
      const tasks = [
        {
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
        },
        {
          id: "00000000-0000-0000-0000-000000000002",
          sessionId: "00000000-0000-0000-0000-00000000aaaa",
          runId: "00000000-0000-0000-0000-00000000cccc",
          prompt: "Another prompt",
          status: "done",
          result: "Full result string that should be pruned out",
          error: null,
          assistantMessages: [
            {
              type: "assistant",
              content: "Answer",
              at: "2026-04-22T00:10:00Z",
            },
          ],
          createdAt: "2026-04-22T00:05:00Z",
          startedAt: "2026-04-22T00:06:00Z",
          finishedAt: "2026-04-22T00:10:00Z",
        },
      ];

      server.use(
        http.get(TASKS_URL, () => {
          return HttpResponse.json({ tasks }, { status: 200 });
        }),
      );

      await voiceChatTaskListCommand.parseAsync([
        "node",
        "cli",
        "00000000-0000-0000-0000-00000000aaaa",
      ]);

      const expected = [
        {
          id: "00000000-0000-0000-0000-000000000001",
          status: "pending",
          createdAt: "2026-04-22T00:00:00Z",
        },
        {
          id: "00000000-0000-0000-0000-000000000002",
          status: "done",
          createdAt: "2026-04-22T00:05:00Z",
        },
      ];

      expect(mockConsoleLog).toHaveBeenCalledWith(
        JSON.stringify(expected, null, 2),
      );
    });

    it("should print an empty array when there are no tasks", async () => {
      server.use(
        http.get(TASKS_URL, () => {
          return HttpResponse.json({ tasks: [] }, { status: 200 });
        }),
      );

      await voiceChatTaskListCommand.parseAsync([
        "node",
        "cli",
        "00000000-0000-0000-0000-00000000aaaa",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify([], null, 2));
    });
  });

  describe("API errors", () => {
    it("should handle 401 unauthorized", async () => {
      server.use(
        http.get(TASKS_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await voiceChatTaskListCommand.parseAsync([
          "node",
          "cli",
          "00000000-0000-0000-0000-00000000aaaa",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });
  });
});
