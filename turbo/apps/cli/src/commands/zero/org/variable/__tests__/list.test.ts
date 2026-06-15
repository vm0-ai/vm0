/**
 * Tests for zero org variable list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("zero org variable list command", () => {
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

  describe("successful list", () => {
    it("should list org variables with values", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json({
            variables: [
              {
                name: "API_URL",
                value: "https://api.example.com",
                description: "External API endpoint",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                name: "DEBUG_MODE",
                value: "true",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Org Variables");
      expect(logCalls).toContain("API_URL");
      expect(logCalls).toContain("https://api.example.com");
      expect(logCalls).toContain("External API endpoint");
      expect(logCalls).toContain("DEBUG_MODE");
      expect(logCalls).toContain("2 variable(s)");
    });

    it("should show empty state when no variables exist", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json({ variables: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No org variables found");
      expect(logCalls).toContain("zero org variable set");
    });

    it("should truncate long values", async () => {
      const longValue = "a".repeat(100);

      server.use(
        http.get("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json({
            variables: [
              {
                name: "LONG_VAR",
                value: longValue,
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("... [truncated]");
      expect(logCalls).not.toContain(longValue);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/variables", () => {
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
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/variables", () => {
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
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("alias", () => {
    it("should have ls alias", () => {
      expect(listCommand.alias()).toBe("ls");
    });
  });
});
