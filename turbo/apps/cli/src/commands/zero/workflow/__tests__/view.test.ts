/**
 * Tests for zero workflow view command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { viewCommand } from "../view";
import chalk from "chalk";

describe("zero workflow view command", () => {
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

  describe("successful view", () => {
    it("should display workflow with content", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/workflows/my-workflow", () => {
          return HttpResponse.json({
            name: "my-workflow",
            displayName: "My Workflow",
            description: "A helpful workflow",
            visibility: "private",
            ownerUserId: "user-123",
            attachedAgentCount: 0,
            attachedAgents: [],
            canManage: true,
            content: "# My Workflow\nDoes helpful things.",
            files: [],
            fileContents: [],
            triggers: [],
          });
        }),
      );

      await viewCommand.parseAsync(["node", "cli", "my-workflow"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-workflow");
      expect(logCalls).toContain("My Workflow");
      expect(logCalls).toContain("A helpful workflow");
      expect(logCalls).toContain("# My Workflow");
    });
  });

  describe("error handling", () => {
    it("should handle workflow not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/workflows/missing", () => {
          return HttpResponse.json(
            { error: { message: "Workflow not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await viewCommand.parseAsync(["node", "cli", "missing"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
