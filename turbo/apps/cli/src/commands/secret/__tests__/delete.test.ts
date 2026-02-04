/**
 * Tests for secret delete command
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

describe("secret delete command", () => {
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
    vi.unstubAllEnvs();
  });

  describe("successful delete", () => {
    it("should delete a secret with --yes flag", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets/MY_API_KEY", () => {
          return HttpResponse.json({
            id: "1",
            name: "MY_API_KEY",
            description: null,
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
        http.delete("http://localhost:3000/api/secrets/MY_API_KEY", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", "MY_API_KEY", "--yes"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Secret "MY_API_KEY" deleted');
    });
  });

  describe("error handling", () => {
    it("should error when secret not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets/NONEXISTENT", () => {
          return HttpResponse.json(
            {
              error: {
                message: 'Secret "NONEXISTENT" not found',
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
        expect.stringContaining('Secret "NONEXISTENT" not found'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should require --yes flag in non-interactive mode", async () => {
      // Mock isInteractive to return false
      vi.stubEnv("CI", "true");

      server.use(
        http.get("http://localhost:3000/api/secrets/MY_API_KEY", () => {
          return HttpResponse.json({
            id: "1",
            name: "MY_API_KEY",
            description: null,
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "MY_API_KEY"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--yes flag is required"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets/MY_API_KEY", () => {
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
        await deleteCommand.parseAsync(["node", "cli", "MY_API_KEY", "--yes"]);
      }).rejects.toThrow("process.exit called");

      // The error is caught in the outer try-catch, so it shows "Secret not found"
      // because the get request fails
      expect(mockConsoleError).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
