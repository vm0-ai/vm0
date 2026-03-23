/**
 * Tests for zero org variable remove command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { removeCommand } from "../remove";

describe("zero org variable remove command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
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

  describe("successful removal", () => {
    it("should remove a variable with --yes flag", async () => {
      server.use(
        http.delete("http://localhost:3000/api/zero/variables/:name", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await removeCommand.parseAsync(["node", "cli", "MY_VAR", "--yes"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('Org variable "MY_VAR" deleted'),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("non-interactive mode", () => {
    it("should require --yes flag in non-interactive mode", async () => {
      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "MY_VAR"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "--yes flag is required in non-interactive mode",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle not found error", async () => {
      server.use(
        http.delete("http://localhost:3000/api/zero/variables/:name", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Variable not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "MY_VAR", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.delete("http://localhost:3000/api/zero/variables/:name", () => {
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
        await removeCommand.parseAsync(["node", "cli", "MY_VAR", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.delete("http://localhost:3000/api/zero/variables/:name", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Internal server error",
                code: "SERVER_ERROR",
              },
            },
            { status: 500 },
          );
        }),
      );

      await expect(async () => {
        await removeCommand.parseAsync(["node", "cli", "MY_VAR", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
