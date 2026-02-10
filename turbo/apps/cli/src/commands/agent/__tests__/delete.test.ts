/**
 * Tests for agent delete command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { deleteCommand } from "../delete";

describe("agent delete command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("successful delete", () => {
    it("should delete agent with --yes flag", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId:
                "abc123def456789012345678901234567890123456789012345678901234",
              content: {
                version: "1",
                agents: {
                  "test-agent": {
                    framework: "claude-code",
                  },
                },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
        http.delete("http://localhost:3000/api/agent/composes/:id", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", "test-agent", "--yes"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("deleted");
    });

    it("should work with -y short flag", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-456",
              name: "test-agent",
              headVersionId: "def456",
              content: {
                version: "1",
                agents: { "test-agent": { framework: "claude-code" } },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
        http.delete("http://localhost:3000/api/agent/composes/:id", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await deleteCommand.parseAsync(["node", "cli", "test-agent", "-y"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("deleted");
    });
  });

  describe("error handling", () => {
    it("should fail when agent not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync([
          "node",
          "cli",
          "nonexistent-agent",
          "--yes",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls.toLowerCase()).toContain("not found");
    });

    it("should fail when agent is currently running", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "running-agent") {
            return HttpResponse.json({
              id: "cmp-789",
              name: "running-agent",
              headVersionId: "abc789",
              content: {
                version: "1",
                agents: { "running-agent": { framework: "claude-code" } },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
        http.delete("http://localhost:3000/api/agent/composes/:id", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Cannot delete agent: agent is currently running",
                code: "CONFLICT",
              },
            },
            { status: 409 },
          );
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync([
          "node",
          "cli",
          "running-agent",
          "--yes",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls).toContain("currently running");
      expect(errorCalls).toContain("vm0 run list");
    });

    it("should handle authentication error", async () => {
      vi.stubEnv("VM0_TOKEN", "");
      vi.stubEnv("HOME", "/tmp/test-no-config");

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "test-agent", "--yes"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls).toContain("Not authenticated");
      expect(errorCalls).toContain("vm0 auth login");
    });

    it("should require --yes flag in non-interactive mode", async () => {
      // Simulate non-interactive mode by not providing a TTY
      vi.stubEnv("CI", "true");

      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: "cmp-123",
              name: "test-agent",
              headVersionId: "abc123",
              content: {
                version: "1",
                agents: { "test-agent": { framework: "claude-code" } },
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "test-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--yes flag is required"),
      );
    });
  });
});
