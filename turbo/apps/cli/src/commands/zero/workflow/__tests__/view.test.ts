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

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const WORKFLOW_ID = "22222222-2222-2222-2222-222222222222";

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
    it("should display workflow with instruction", async () => {
      server.use(
        http.get(
          `http://localhost:3000/api/zero/workflows/${WORKFLOW_ID}`,
          () => {
            return HttpResponse.json({
              id: WORKFLOW_ID,
              agentId: AGENT_ID,
              agentName: "my-agent",
              agentDisplayName: "My Agent",
              name: "my-workflow",
              displayName: "My Workflow",
              description: "A helpful workflow",
              visibility: "private",
              requestToPublish: false,
              ownerUserId: "user-123",
              canManage: true,
              instruction: "Do helpful things.",
              files: [],
              fileContents: [],
              triggers: [],
            });
          },
        ),
      );

      await viewCommand.parseAsync(["node", "cli", WORKFLOW_ID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-workflow");
      expect(logCalls).toContain("My Workflow");
      expect(logCalls).toContain("A helpful workflow");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("Do helpful things.");
    });
  });

  describe("error handling", () => {
    it("should handle workflow not found", async () => {
      const missingId = "99999999-9999-9999-9999-999999999999";
      server.use(
        http.get(
          `http://localhost:3000/api/zero/workflows/${missingId}`,
          () => {
            return HttpResponse.json(
              { error: { message: "Workflow not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await viewCommand.parseAsync(["node", "cli", missingId]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
