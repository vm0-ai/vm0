/**
 * Tests for secret list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("secret list command", () => {
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

  describe("help text", () => {
    it("should show ls alias", async () => {
      const mockStdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        await listCommand.parseAsync(["node", "cli", "--help"]);
      } catch {
        // Commander calls process.exit(0) after help
      }

      const output = mockStdoutWrite.mock.calls.map((call) => call[0]).join("");

      expect(output).toContain("List all secrets");
      expect(output).toContain("ls");

      mockStdoutWrite.mockRestore();
    });
  });

  describe("successful list", () => {
    it("should display secrets in table format", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                id: "1",
                name: "MY_API_KEY",
                description: "API key for testing",
                type: "user",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                id: "2",
                name: "GITHUB_TOKEN",
                description: "GitHub access token",
                type: "user",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("MY_API_KEY");
      expect(logCalls).toContain("GITHUB_TOKEN");
    });

    it("should display empty state message when no secrets", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({ secrets: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No secrets found");
    });
  });

  describe("connector secrets", () => {
    it("should display connector secret with derived env var names", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                id: "1",
                name: "GITHUB_ACCESS_TOKEN",
                description: null,
                type: "connector",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("GITHUB_ACCESS_TOKEN");
      expect(logCalls).toContain("[GitHub connector]");
      expect(logCalls).toContain("Available as: GH_TOKEN, GITHUB_TOKEN");
    });

    it("should display connector secret without derived names when no mapping found", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                id: "1",
                name: "UNKNOWN_CONNECTOR_SECRET",
                description: null,
                type: "connector",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("UNKNOWN_CONNECTOR_SECRET");
      expect(logCalls).toContain("[connector]");
      expect(logCalls).not.toContain("Available as:");
    });

    it("should display mixed secret types correctly", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                id: "1",
                name: "MY_API_KEY",
                description: "User secret",
                type: "user",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                id: "2",
                name: "ANTHROPIC_API_KEY",
                description: null,
                type: "model-provider",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                id: "3",
                name: "GITHUB_ACCESS_TOKEN",
                description: null,
                type: "connector",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("MY_API_KEY");
      expect(logCalls).not.toContain("MY_API_KEY [");
      expect(logCalls).toContain("[model-provider]");
      expect(logCalls).toContain("[GitHub connector]");
      expect(logCalls).toContain("Available as: GH_TOKEN, GITHUB_TOKEN");
      expect(logCalls).toContain("Total: 3 secret(s)");
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/secrets", () => {
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
  });
});
