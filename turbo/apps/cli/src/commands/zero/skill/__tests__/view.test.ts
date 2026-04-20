/**
 * Tests for zero skill view command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { viewCommand } from "../view";
import chalk from "chalk";

describe("zero skill view command", () => {
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

  describe("successful view", () => {
    it("should display skill with content", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/skills/my-skill", () => {
          return HttpResponse.json({
            name: "my-skill",
            displayName: "My Skill",
            description: "A helpful skill",
            content: "# My Skill\nDoes helpful things.",
          });
        }),
      );

      await viewCommand.parseAsync(["node", "cli", "my-skill"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-skill");
      expect(logCalls).toContain("My Skill");
      expect(logCalls).toContain("A helpful skill");
      expect(logCalls).toContain("# My Skill");
    });
  });

  describe("error handling", () => {
    it("should handle skill not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/skills/missing", () => {
          return HttpResponse.json(
            { error: { message: "Skill not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await viewCommand.parseAsync(["node", "cli", "missing"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
