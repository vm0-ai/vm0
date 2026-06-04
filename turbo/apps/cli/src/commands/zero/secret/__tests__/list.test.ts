/**
 * Tests for zero secret list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators, connector display lookups
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("zero secret list command", () => {
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
    it("should list secrets with metadata", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                name: "MY_API_KEY",
                description: "API key for service",
                type: "user",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                name: "DB_PASSWORD",
                type: "user",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Secrets");
      expect(logCalls).toContain("MY_API_KEY");
      expect(logCalls).toContain("API key for service");
      expect(logCalls).toContain("DB_PASSWORD");
      expect(logCalls).toContain("2 secret(s)");
    });

    it("should show empty state when no secrets exist", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({ secrets: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No secrets found");
      expect(logCalls).toContain("zero secret set");
    });
  });

  describe("connector secrets", () => {
    it("should display connector secret with derived environment names", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                name: "GITHUB_ACCESS_TOKEN",
                type: "connector",
                updatedAt: "2025-01-01T00:00:00Z",
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
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                name: "UNKNOWN_CONNECTOR_SECRET",
                type: "connector",
                updatedAt: "2025-01-01T00:00:00Z",
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

    it("should display model-provider type indicator", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                name: "ANTHROPIC_API_KEY",
                type: "model-provider",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("ANTHROPIC_API_KEY");
      expect(logCalls).toContain("[model-provider]");
    });

    it("should display mixed secret types correctly", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                name: "MY_API_KEY",
                description: "User secret",
                type: "user",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                name: "ANTHROPIC_API_KEY",
                type: "model-provider",
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                name: "GITHUB_ACCESS_TOKEN",
                type: "connector",
                updatedAt: "2025-01-01T00:00:00Z",
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
        http.get("http://localhost:3000/api/zero/secrets", () => {
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
        http.get("http://localhost:3000/api/zero/secrets", () => {
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
