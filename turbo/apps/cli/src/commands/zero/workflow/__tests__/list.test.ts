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

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

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
              id: "22222222-2222-2222-2222-222222222222",
              agentId: AGENT_ID,
              agentName: "my-agent",
              agentDisplayName: "My Agent",
              name: "code-review",
              displayName: "Code Review",
              description: "Reviews code",
              visibility: "private",
              requestToPublish: false,
              ownerUserId: "user-123",
              canManage: true,
            },
            {
              id: "33333333-3333-3333-3333-333333333333",
              agentId: AGENT_ID,
              agentName: "my-agent",
              agentDisplayName: "My Agent",
              name: "deploy",
              displayName: null,
              description: null,
              visibility: "public",
              requestToPublish: false,
              ownerUserId: "user-123",
              canManage: false,
            },
          ]);
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("code-review");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("private");
      expect(logCalls).toContain("deploy");
    });

    it("should pass agentId query when --agent is provided", async () => {
      let capturedUrl: string | undefined;
      server.use(
        http.get("http://localhost:3000/api/zero/workflows", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json([]);
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_ID]);

      expect(capturedUrl).toContain(`agentId=${AGENT_ID}`);
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
