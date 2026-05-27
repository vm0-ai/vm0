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
  permissionPolicies: null,
};

function mockConnectorListHandler(
  connectors: Record<string, unknown>[] = [],
  configuredTypes: string[] = [],
) {
  return http.get("http://localhost:3000/api/zero/connectors", () => {
    return HttpResponse.json({
      connectors,
      configuredTypes,
      connectorProvidedEnvNames: [],
    });
  });
}

function makeConnector(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    type: "github",
    authMethod: "oauth",
    externalId: "12345",
    externalUsername: "octocat",
    externalEmail: "octocat@github.com",
    oauthScopes: ["repo"],
    needsReconnect: false,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

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
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("comp_abc123");
      expect(logCalls).toContain("A test agent");
      expect(logCalls).toContain("professional");
      expect(logCalls).toContain("github (full access)");
    });

    it("should display preset avatar", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: "preset:2",
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: [] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Avatar:");
      expect(logCalls).toContain(
        "preset:2 (medium skin, pink hair, neutral, chill)",
      );
    });

    it("should display custom svg avatar", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: "svg:r3s4h1c2f5h",
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: [] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Avatar:");
      expect(logCalls).toContain(
        "custom (dark skin, teal hair, excited, hyped)",
      );
    });

    it("should not display avatar when null", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            avatarUrl: null,
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: [] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("Avatar:");
    });

    it("should show permission summary with permission policies", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/agents/my-agent", () => {
          return HttpResponse.json({
            ...mockAgent,
            permissionPolicies: {
              slack: {
                policies: {
                  "channels:read": "allow",
                  "chat:write": "deny",
                  "reactions:read": "allow",
                  admin: "deny",
                },
              },
            },
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["slack"] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toMatch(/slack \(\d+\/\d+ allowed\)/);
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
        mockConnectorListHandler(),
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
        mockConnectorListHandler(),
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
            permissionPolicies: {
              slack: {
                policies: {
                  "channels:read": "allow",
                  "chat:write": "deny",
                  "reactions:read": "allow",
                  admin: "ask",
                },
              },
            },
          });
        }),
        http.get(
          "http://localhost:3000/api/zero/agents/my-agent/user-connectors",
          () => {
            return HttpResponse.json({ enabledTypes: ["slack"] });
          },
        ),
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toMatch(/slack \(\d+\/\d+ allowed\)/);
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
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("unknown endpoints");
    });

    it("should handle connectors without permissions gracefully", async () => {
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
        mockConnectorListHandler(),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("custom-connector");
    });
  });

  describe("connector identity", () => {
    it("should show identity in connector summary line", async () => {
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
        mockConnectorListHandler([makeConnector()], ["github"]),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github @octocat (full access)");
    });

    it("should show full identity in permissions detail", async () => {
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
        mockConnectorListHandler([makeConnector()], ["github"]),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("@octocat (octocat@github.com)");
    });

    it("should work without identity when connector API fails", async () => {
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
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json(
            { error: { message: "Forbidden", code: "FORBIDDEN" } },
            { status: 403 },
          );
        }),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github (full access)");
      expect(logCalls).not.toContain("@octocat");
    });

    it("should skip identity for connectors without identity data", async () => {
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
        mockConnectorListHandler(
          [
            makeConnector({
              authMethod: "api-token",
              externalUsername: null,
              externalEmail: null,
            }),
          ],
          ["github"],
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("@");
    });

    it("should show needs reconnect warning in identity line", async () => {
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
        mockConnectorListHandler(
          [makeConnector({ needsReconnect: true })],
          ["github"],
        ),
      );

      await viewCommand.parseAsync([
        "node",
        "cli",
        "my-agent",
        "--permissions",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("@octocat (octocat@github.com)");
      expect(logCalls).toContain("(needs reconnect)");
    });

    it("should show email-only identity when no username", async () => {
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
        mockConnectorListHandler(
          [
            makeConnector({
              externalUsername: null,
              externalEmail: "user@example.com",
            }),
          ],
          ["github"],
        ),
      );

      await viewCommand.parseAsync(["node", "cli", "my-agent"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github user@example.com (full access)");
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
