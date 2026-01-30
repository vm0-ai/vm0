/**
 * Tests for credential delete command
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

describe("credential delete command", () => {
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

  describe("help text", () => {
    it("should show usage information", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await deleteCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Delete a credential");
      expect(output).toContain("<name>");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("successful delete", () => {
    it("should delete credential with confirmation flag", async () => {
      server.use(
        http.get("http://localhost:3000/api/credentials/:name", () => {
          return HttpResponse.json({
            name: "MY_API_KEY",
            description: "API key for testing",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
        http.delete("http://localhost:3000/api/credentials/:name", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", "MY_API_KEY", "-y"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("MY_API_KEY");
      expect(logCalls).toContain("deleted");
    });
  });

  describe("error handling", () => {
    it("should fail when deleting non-existent credential", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/credentials/:name",
          ({ params }) => {
            const { name } = params;
            return HttpResponse.json(
              {
                error: {
                  message: `Credential "${name}" not found`,
                  code: "NOT_FOUND",
                },
              },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await deleteCommand.parseAsync([
          "node",
          "cli",
          "NONEXISTENT_CRED",
          "-y",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/credentials/:name", () => {
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
        await deleteCommand.parseAsync(["node", "cli", "MY_API_KEY", "-y"]);
      }).rejects.toThrow("process.exit called");

      // The delete command catches the error and displays "not found" message
      // because it wraps the get call in a try/catch
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
