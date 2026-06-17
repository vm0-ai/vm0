/**
 * Tests for zero workflow list command
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

describe("zero workflow list command", () => {
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
    it("should display workflows in table format", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/workflows", () => {
          return HttpResponse.json([
            {
              name: "code-review",
              displayName: "Code Review",
              description: "Reviews code",
              visibility: "private",
              ownerUserId: "user-123",
              attachedAgentCount: 1,
              attachedAgents: [],
              canManage: true,
            },
            {
              name: "deploy",
              displayName: null,
              description: null,
              visibility: "public",
              ownerUserId: "user-123",
              attachedAgentCount: 0,
              attachedAgents: [],
              canManage: false,
            },
          ]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("code-review");
      expect(logCalls).toContain("Code Review");
      expect(logCalls).toContain("private");
      expect(logCalls).toContain("deploy");
    });

    it("should show empty state when no workflows", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/workflows", () => {
          return HttpResponse.json([]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No workflows found");
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/workflows", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
