/**
 * Tests for zero workflow copy command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { copyCommand } from "../copy";
import chalk from "chalk";

const SOURCE_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_AGENT_ID = "33333333-3333-3333-3333-333333333333";
const NEW_ID = "44444444-4444-4444-4444-444444444444";

describe("zero workflow copy command", () => {
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

  describe("successful copy", () => {
    it("should copy a workflow onto another agent", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          `http://localhost:3000/api/zero/workflows/${SOURCE_ID}/copy`,
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              {
                id: NEW_ID,
                agentId: TARGET_AGENT_ID,
                agentName: "target-agent",
                agentDisplayName: "Target Agent",
                name: "my-workflow",
                displayName: "My Workflow",
                description: null,
                visibility: "private",
                requestToPublish: false,
                ownerUserId: "user-123",
                canManage: true,
              },
              { status: 201 },
            );
          },
        ),
      );

      await copyCommand.parseAsync([
        "node",
        "cli",
        SOURCE_ID,
        "--to-agent",
        TARGET_AGENT_ID,
      ]);

      expect(capturedBody?.toAgentId).toBe(TARGET_AGENT_ID);
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("copied");
      expect(logCalls).toContain(NEW_ID);
      expect(logCalls).toContain("target-agent");
    });
  });

  describe("error handling", () => {
    it("should handle workflow not found", async () => {
      server.use(
        http.post(
          `http://localhost:3000/api/zero/workflows/${SOURCE_ID}/copy`,
          () => {
            return HttpResponse.json(
              { error: { message: "Workflow not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          },
        ),
      );

      await expect(async () => {
        await copyCommand.parseAsync([
          "node",
          "cli",
          SOURCE_ID,
          "--to-agent",
          TARGET_AGENT_ID,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
