/**
 * Tests for zero workflow run command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { runCommand } from "../run";
import chalk from "chalk";

const WORKFLOW_ID = "22222222-2222-2222-2222-222222222222";
const CHAT_THREAD_ID = "33333333-3333-3333-3333-333333333333";

describe("zero workflow run command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("successful run", () => {
    it("should start a workflow run", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/zero/workflows/${WORKFLOW_ID}/run`,
          () => {
            return HttpResponse.json({
              chatThreadId: CHAT_THREAD_ID,
              runId: "run-abc",
            });
          },
        ),
      );

      await runCommand.parseAsync(["node", "cli", WORKFLOW_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("run started");
      expect(logCalls).toContain("run-abc");
      expect(logCalls).toContain(CHAT_THREAD_ID);
    });
  });

  describe("error handling", () => {
    it("should handle workflow not found", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/zero/workflows/${WORKFLOW_ID}/run`,
          () => {
            return HttpResponse.json(
              { error: { message: "Workflow not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await runCommand.parseAsync(["node", "cli", WORKFLOW_ID]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
