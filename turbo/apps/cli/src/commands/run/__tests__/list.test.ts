/**
 * Tests for run list command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import chalk from "chalk";

describe("run list command", () => {
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

  describe("successful list", () => {
    it("should list active runs with formatted output", async () => {
      const runs = [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          agentName: "test-agent-1",
          status: "running",
          createdAt: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440002",
          agentName: "test-agent-2",
          status: "pending",
          createdAt: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
        },
      ];

      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json({ runs });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      // Check header
      expect(logCalls).toContain("ID");
      expect(logCalls).toContain("AGENT");
      expect(logCalls).toContain("STATUS");
      expect(logCalls).toContain("CREATED");
      // Check run data
      expect(logCalls).toContain("550e8400-e29b-41d4-a716-446655440001");
      expect(logCalls).toContain("test-agent-1");
      expect(logCalls).toContain("running");
      expect(logCalls).toContain("550e8400-e29b-41d4-a716-446655440002");
      expect(logCalls).toContain("test-agent-2");
      expect(logCalls).toContain("pending");
    });

    it("should show message when no active runs", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No active runs");
    });

    it("should handle single run", async () => {
      const runs = [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          agentName: "my-agent",
          status: "running",
          createdAt: new Date().toISOString(),
        },
      ];

      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json({ runs });
        }),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-agent");
      expect(logCalls).toContain("running");
    });
  });

  describe("filtering options", () => {
    it("should pass --status filter to API", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--status", "completed"]);

      expect(capturedUrl?.searchParams.get("status")).toBe("completed");
    });

    it("should pass multiple statuses as comma-separated", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync([
        "node",
        "cli",
        "--status",
        "completed,failed",
      ]);

      expect(capturedUrl?.searchParams.get("status")).toBe("completed,failed");
    });

    it("should pass all statuses when --all is used", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--all"]);

      expect(capturedUrl?.searchParams.get("status")).toBe(
        "pending,running,completed,failed,timeout",
      );
    });

    it("should pass --agent filter to API", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", "my-agent"]);

      expect(capturedUrl?.searchParams.get("agent")).toBe("my-agent");
    });

    it("should pass --limit to API", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--limit", "10"]);

      expect(capturedUrl?.searchParams.get("limit")).toBe("10");
    });

    it("should pass --since as ISO timestamp to API", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--since", "7d"]);

      const since = capturedUrl?.searchParams.get("since");
      expect(since).toBeTruthy();
      // Should be a valid ISO timestamp
      expect(new Date(since!).toISOString()).toBe(since);
    });

    it("should use all statuses implicitly when --since is used", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--since", "7d"]);

      expect(capturedUrl?.searchParams.get("status")).toBe(
        "pending,running,completed,failed,timeout",
      );
    });

    it("should allow explicit --status to override --since default", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync([
        "node",
        "cli",
        "--since",
        "7d",
        "--status",
        "failed",
      ]);

      expect(capturedUrl?.searchParams.get("status")).toBe("failed");
    });

    it("should pass --until as ISO timestamp to API", async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get("http://localhost:3000/api/agent/runs", ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--until", "1h"]);

      const until = capturedUrl?.searchParams.get("until");
      expect(until).toBeTruthy();
      // Should be a valid ISO timestamp
      expect(new Date(until!).toISOString()).toBe(until);
    });

    it("should show 'No runs found matching filters' when filters used and no results", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json({ runs: [] });
        }),
      );

      await listCommand.parseAsync(["node", "cli", "--status", "completed"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No runs found matching filters");
    });
  });

  describe("validation errors", () => {
    it("should error when --all and --status are both specified", async () => {
      await expect(async () => {
        await listCommand.parseAsync([
          "node",
          "cli",
          "--all",
          "--status",
          "running",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--all and --status are mutually exclusive"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error on invalid status value", async () => {
      await expect(async () => {
        await listCommand.parseAsync(["node", "cli", "--status", "invalid"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid status "invalid"'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error when --limit exceeds maximum", async () => {
      await expect(async () => {
        await listCommand.parseAsync(["node", "cli", "--limit", "200"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--limit must be between 1 and 100"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error when --limit is zero or negative", async () => {
      await expect(async () => {
        await listCommand.parseAsync(["node", "cli", "--limit", "0"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--limit must be between 1 and 100"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error when --since is after --until", async () => {
      await expect(async () => {
        await listCommand.parseAsync([
          "node",
          "cli",
          "--since",
          "1d",
          "--until",
          "7d",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--since must be before --until"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should error on invalid time format", async () => {
      await expect(async () => {
        await listCommand.parseAsync(["node", "cli", "--since", "invalid"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid --since format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
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
        expect.stringContaining("Failed to list runs"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle generic API error", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
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
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list runs"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("alias", () => {
    it("should work with ls alias", async () => {
      server.use(
        http.get("http://localhost:3000/api/agent/runs", () => {
          return HttpResponse.json({ runs: [] });
        }),
      );

      // The alias is defined on the command, verify it exists
      expect(listCommand.alias()).toBe("ls");
    });
  });
});
