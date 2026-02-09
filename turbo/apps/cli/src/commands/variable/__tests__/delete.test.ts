/**
 * Tests for variable delete command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { deleteCommand } from "../delete";
import chalk from "chalk";

describe("variable delete command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
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
    it("should delete a variable with --yes flag", async () => {
      server.use(
        http.get("http://localhost:3000/api/variables/MY_VAR", () => {
          return HttpResponse.json({
            id: "1",
            name: "MY_VAR",
            value: "my-value",
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
        http.delete("http://localhost:3000/api/variables/MY_VAR", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", "MY_VAR", "--yes"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Variable "MY_VAR" deleted');
    });
  });

  describe("error handling", () => {
    it("should error when variable not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/variables/NONEXISTENT", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Variable "NONEXISTENT" not found',
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "NONEXISTENT", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Variable "NONEXISTENT" not found'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --yes flag in non-interactive mode", async () => {
      // Mock isInteractive to return false
      vi.stubEnv("CI", "true");

      server.use(
        http.get("http://localhost:3000/api/variables/MY_VAR", () => {
          return HttpResponse.json({
            id: "1",
            name: "MY_VAR",
            value: "my-value",
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "MY_VAR"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--yes flag is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error on get", async () => {
      server.use(
        http.get("http://localhost:3000/api/variables/MY_VAR", () => {
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
        await deleteCommand.parseAsync(["node", "cli", "MY_VAR", "--yes"]);
      }).rejects.toThrow("process.exit called");

      // The error propagates to outer catch which shows auth message
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error on delete", async () => {
      server.use(
        http.get("http://localhost:3000/api/variables/MY_VAR", () => {
          return HttpResponse.json({
            id: "1",
            name: "MY_VAR",
            value: "my-value",
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
        http.delete("http://localhost:3000/api/variables/MY_VAR", () => {
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
        await deleteCommand.parseAsync(["node", "cli", "MY_VAR", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
