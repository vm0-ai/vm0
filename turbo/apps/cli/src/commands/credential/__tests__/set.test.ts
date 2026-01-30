/**
 * Tests for credential set command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { setCommand } from "../set";
import chalk from "chalk";

describe("credential set command", () => {
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

  describe("error handling", () => {
    it("should handle authentication error", async () => {
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
  });
});
