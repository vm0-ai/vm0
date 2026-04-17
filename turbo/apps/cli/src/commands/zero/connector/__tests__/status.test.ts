/**
 * Tests for zero connector status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { statusCommand } from "../status";
import chalk from "chalk";

describe("zero connector status command", () => {
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

  describe("connected connector", () => {
    it("should display connected status with details", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/connectors/:type", () => {
          return HttpResponse.json({
            id: "1",
            type: "github",
            authMethod: "oauth",
            externalId: "12345",
            externalUsername: "octocat",
            externalEmail: "octocat@github.com",
            oauthScopes: ["repo", "project"],
            needsReconnect: false,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("connected");
      expect(logCalls).toContain("@octocat");
      expect(logCalls).toContain("oauth");
    });
  });

  describe("not connected", () => {
    it("should display not connected status", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/connectors/:type", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("not connected");
    });
  });

  describe("input validation", () => {
    it("should reject invalid connector type", async () => {
      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "invalid-type"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown connector type: invalid-type"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Available connectors:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/connectors/:type", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
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
  });
});
