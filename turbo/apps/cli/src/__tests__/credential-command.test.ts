/**
 * Unit tests for credential command validation and help text
 *
 * These tests validate credential name validation rules and help text output.
 * They replace E2E tests that tested the same behavior through the full stack.
 *
 * Key behaviors tested:
 * - Credential name validation (uppercase, no dashes, must start with letter)
 * - Help text for list, set, and delete subcommands
 * - Non-existent credential deletion error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { setCommand } from "../commands/credential/set";
import { listCommand } from "../commands/credential/list";
import { deleteCommand } from "../commands/credential/delete";
import { credentialCommand } from "../commands/credential/index";
import chalk from "chalk";

describe("Credential Command", () => {
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
    it("credential --help shows command description", async () => {
      // Commander outputs help to stdout via process.stdout.write
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await credentialCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Manage stored credentials");
      expect(output).toContain("list");
      expect(output).toContain("set");
      expect(output).toContain("delete");

      mockStdoutWrite.mockRestore();
    });

    it("credential list --help shows ls alias", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await listCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("List all credentials");
      expect(output).toContain("ls");

      mockStdoutWrite.mockRestore();
    });

    it("credential set --help shows usage", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await setCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("Create or update a credential");
      expect(output).toContain("<name>");
      expect(output).toContain("<value>");
      expect(output).toContain("--description");

      mockStdoutWrite.mockRestore();
    });

    it("credential delete --help shows usage", async () => {
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

  describe("credential name validation", () => {
    it("should reject lowercase names", async () => {
      server.use(
        http.put("http://localhost:3000/api/credentials", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Credential name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_API_KEY)",
                code: "VALIDATION_ERROR",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "my_api_key", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must contain only uppercase"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject names starting with numbers", async () => {
      server.use(
        http.put("http://localhost:3000/api/credentials", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Credential name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_API_KEY)",
                code: "VALIDATION_ERROR",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "123_KEY", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must contain only uppercase"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject names with dashes", async () => {
      server.use(
        http.put("http://localhost:3000/api/credentials", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Credential name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_API_KEY)",
                code: "VALIDATION_ERROR",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "MY-API-KEY", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must contain only uppercase"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show examples of valid credential names on validation error", async () => {
      server.use(
        http.put("http://localhost:3000/api/credentials", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Credential name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_API_KEY)",
                code: "VALIDATION_ERROR",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "invalid-name", "value"]);
      }).rejects.toThrow("process.exit called");

      // Should show examples of valid names
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Examples of valid credential names"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("MY_API_KEY"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("GITHUB_TOKEN"),
      );
    });
  });

  describe("delete non-existent credential", () => {
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
  });

  describe("authentication errors", () => {
    it("should handle not authenticated error for set", async () => {
      server.use(
        http.put("http://localhost:3000/api/credentials", () => {
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
        await setCommand.parseAsync(["node", "cli", "MY_API_KEY", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle not authenticated error for list", async () => {
      server.use(
        http.get("http://localhost:3000/api/credentials", () => {
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
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle not authenticated error for delete", async () => {
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
