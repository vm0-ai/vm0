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
const SOURCE_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const RESOLVED_SOURCE_ID = "66666666-6666-4666-8666-666666666666";

function workflowSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOLVED_SOURCE_ID,
    agentId: SOURCE_AGENT_ID,
    agentName: "source-agent",
    agentDisplayName: "Source Agent",
    name: "tell-a-joke",
    displayName: "Tell a joke",
    description: null,
    visibility: "private",
    ownerUserId: "user-123",
    canManage: true,
    canPublish: true,
    shadowedBy: null,
    ...overrides,
  };
}

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
    vi.unstubAllEnvs();
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
                ownerUserId: "user-123",
                canManage: true,
                canPublish: true,
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
      expect(logCalls).toContain("Agent Name:   Target Agent");
      expect(logCalls).toContain(`Agent ID:     ${TARGET_AGENT_ID}`);
    });

    it("should resolve a source workflow name before copying", async () => {
      let copiedWorkflowId: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/zero/workflows", () => {
          return HttpResponse.json([workflowSummary()]);
        }),
        http.post(
          "http://localhost:3000/api/zero/workflows/:workflowId/copy",
          ({ params }) => {
            copiedWorkflowId = params.workflowId as string;
            return HttpResponse.json(
              {
                id: NEW_ID,
                agentId: TARGET_AGENT_ID,
                agentName: "target-agent",
                agentDisplayName: "Target Agent",
                name: "tell-a-joke",
                displayName: "Tell a joke",
                description: null,
                visibility: "private",
                ownerUserId: "user-123",
                canManage: true,
                canPublish: true,
              },
              { status: 201 },
            );
          },
        ),
      );

      await copyCommand.parseAsync([
        "node",
        "cli",
        "tell-a-joke",
        "--agent",
        SOURCE_AGENT_ID,
        "--to-agent",
        TARGET_AGENT_ID,
      ]);

      expect(copiedWorkflowId).toBe(RESOLVED_SOURCE_ID);
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
