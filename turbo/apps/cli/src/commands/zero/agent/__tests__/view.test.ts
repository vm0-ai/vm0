/**
 * Tests for zero agent view command
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

const mockAgent = {
  agentId: "comp_abc123",
  displayName: "My Agent",
  description: "A test agent",
  sound: "professional",
  firewallPolicies: null,
};

describe("zero agent view command", () => {
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
    it("should display agent info", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("comp_abc123");
      expect(logCalls).toContain("A test agent");
      expect(logCalls).toContain("professional");
      expect(logCalls).toContain("github (full access)");
    });

    it("should show permission summary with firewall policies", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            firewallPolicies: {
              github: {
                "actions:read": "allow",
                "actions:write": "deny",
                "contents:read": "allow",
                "contents:write": "deny",
              },
            },
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toMatch(/github \(\d+\/\d+ allowed\)/);
    });

    it("should show instructions content with --instructions flag", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: [] });
          },
        ),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/instructions",
          () => {
            return HttpResponse.json({
              content: "Do the thing",
              filename: "CLAUDE.md",
            });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--instructions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Do the thing");
    });

    it("should show empty instructions message when no instructions set", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: [] });
          },
        ),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/instructions",
          () => {
            return HttpResponse.json({ content: null, filename: null });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--instructions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("No instructions set");
    });
  });

  describe("--permissions flag", () => {
    it("should show detailed permissions with allow/deny icons", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            firewallPolicies: {
              github: {
                "actions:read": "allow",
                "actions:write": "deny",
                "contents:read": "allow",
                "contents:write": "ask",
              },
            },
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toMatch(/github \(\d+\/\d+ allowed\)/);
      expect(logCalls).toContain("✓");
      expect(logCalls).toContain("✗");
      expect(logCalls).toContain("?");
    });

    it("should show full access for connectors without policies", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["github"] });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("full access");
      expect(logCalls).toContain(
        "No permission rules configured — all API calls allowed.",
      );
    });

    it("should handle non-firewall connectors gracefully", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json(mockAgent);
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({
              enabledTypes: ["custom-connector"],
            });
          },
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("custom-connector");
      expect(logCalls).toContain("No firewall configured.");
    });
  });

  describe("error handling", () => {
    it("should handle not found error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/missing", () => {
          return HttpResponse.json(
            { error: { message: "Agent not found", code: "NOT_FOUND" } },
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
