/**
 * Tests for zero skill delete command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { deleteCommand } from "../delete";
import chalk from "chalk";

describe("zero skill delete command", () => {
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

  describe("successful delete", () => {
    it("should delete with --yes flag without prompting", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/skills/my-skill", () => {
          return HttpResponse.json({
            name: "my-skill",
            displayName: "My Skill",
            description: null,
            content: "# Skill",
          });
        }),
        http.delete("http://localhost:3000/api/zero/skills/my-skill", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", "my-skill", "--yes"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-skill");
      expect(logCalls).toContain("deleted");
    });
  });

  describe("error handling", () => {
    it("should handle not found error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/skills/missing", () => {
          return HttpResponse.json(
            { error: { message: "Skill not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "missing", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --yes in non-interactive mode", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/skills/my-skill", () => {
          return HttpResponse.json({
            name: "my-skill",
            displayName: null,
            description: null,
            content: "# Skill",
          });
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "my-skill"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--yes flag is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
