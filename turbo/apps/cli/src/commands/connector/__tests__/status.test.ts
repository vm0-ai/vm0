/**
 * Tests for connector status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { statusCommand } from "../status";
import chalk from "chalk";

describe("connector status command", () => {
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
    vi.unstubAllEnvs();
  });

  describe("connected connector", () => {
    it("should display all connector details", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors/github", () => {
          return HttpResponse.json({
            id: "1",
            type: "github",
            authMethod: "oauth",
            externalId: "12345",
            externalUsername: "octocat",
            externalEmail: "octocat@github.com",
            oauthScopes: ["repo", "user"],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-15T00:00:00Z",
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Connector:");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("Status:");
      expect(logCalls).toContain("connected");
      expect(logCalls).toContain("Account:");
      expect(logCalls).toContain("@octocat");
      expect(logCalls).toContain("Auth Method:");
      expect(logCalls).toContain("oauth");
      expect(logCalls).toContain("OAuth Scopes:");
      expect(logCalls).toContain("repo, user");
      expect(logCalls).toContain("Connected:");
      expect(logCalls).toContain("Last Updated:");
    });

    it("should show disconnect hint when connected", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors/github", () => {
          return HttpResponse.json({
            id: "1",
            type: "github",
            authMethod: "oauth",
            externalId: "12345",
            externalUsername: "octocat",
            externalEmail: null,
            oauthScopes: ["repo"],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("To disconnect:");
      expect(logCalls).toContain("vm0 connector disconnect github");
    });

    it("should not show Last Updated when same as Connected", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors/github", () => {
          return HttpResponse.json({
            id: "1",
            type: "github",
            authMethod: "oauth",
            externalId: "12345",
            externalUsername: "octocat",
            externalEmail: null,
            oauthScopes: ["repo"],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Connected:");
      expect(logCalls).not.toContain("Last Updated:");
    });
  });

  describe("not connected", () => {
    it("should show not connected status on 404", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors/github", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Connector not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Connector:");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("Status:");
      expect(logCalls).toContain("not connected");
    });

    it("should show connect hint when not connected", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors/github", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Connector not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("To connect:");
      expect(logCalls).toContain("vm0 connector connect github");
    });
  });

  describe("invalid type", () => {
    it("should show error with available types", async () => {
      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "invalid"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown connector type: invalid"),
      );
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Available connectors:");
      expect(logCalls).toContain("github");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors/github", () => {
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
        await statusCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle server error", async () => {
      server.use(
        http.get("http://localhost:3000/api/connectors/github", () => {
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
        await statusCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
