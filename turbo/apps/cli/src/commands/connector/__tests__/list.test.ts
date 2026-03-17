/**
 * Tests for connector list command
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

describe("connector list command", () => {
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

  afterEach(() => {});

  describe("successful list", () => {
    it("should show connected connector with status and account", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github"],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("TYPE");
      expect(logCalls).toContain("STATUS");
      expect(logCalls).toContain("ACCOUNT");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("✓");
      expect(logCalls).toContain("@octocat");
    });

    it("should show not-connected status when no connectors", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json({ connectors: [], configuredTypes: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).not.toContain("✓");
      expect(logCalls).not.toContain("@octocat");
    });

    it("should show reconnect needed status for needsReconnect connector", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo"],
                needsReconnect: true,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github"],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("!");
      expect(logCalls).toContain("(reconnect needed)");
      expect(logCalls).not.toContain("✓");
    });

    it("should always show connect hint", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: null,
                oauthScopes: ["repo"],
                needsReconnect: false,
                createdAt: "2025-01-01T00:00:00Z",
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
            configuredTypes: ["github"],
          });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("To connect a service:");
      expect(logCalls).toContain("vm0 connector connect <type>");
    });
  });

  describe("error handling", () => {
    it("should show auth login hint for UNAUTHORIZED error", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
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
        expect.stringContaining("Run: vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show status code and message for non-auth API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
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
        expect.stringContaining("500: Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle network error", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors", () => {
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      // Network error from HttpResponse.error() manifests as "Failed to fetch"
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show auth login hint when token is missing", async () => {
      vi.stubEnv("VM0_TOKEN", "");

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Run: vm0 auth login"),
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
