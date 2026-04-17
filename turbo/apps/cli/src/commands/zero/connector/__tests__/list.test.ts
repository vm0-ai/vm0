/**
 * Tests for zero connector list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("zero connector list command", () => {
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

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("successful list", () => {
    it("should show connected connector with status and account", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo", "project", "workflow"],
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
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({ connectors: [], configuredTypes: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).not.toContain("✓");
      expect(logCalls).not.toContain("@octocat");
    });

    it("should show reconnect needed status", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [
              {
                id: "1",
                type: "github",
                authMethod: "oauth",
                externalId: "12345",
                externalUsername: "octocat",
                externalEmail: "octocat@github.com",
                oauthScopes: ["repo", "project", "workflow"],
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
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
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
  });

  describe("alias", () => {
    it("should have ls alias", () => {
      expect(listCommand.alias()).toBe("ls");
    });
  });
});
