/**
 * Tests for zero connector list command
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

const AGENT_UUID = "550e8400-e29b-41d4-a716-446655440000";
const ALT_AGENT_UUID = "550e8400-e29b-41d4-a716-446655440099";

const connectedGithub = {
  id: "1",
  type: "github",
  authMethod: "oauth",
  externalId: "12345",
  externalUsername: "octocat",
  externalEmail: "octocat@github.com",
  oauthScopes: ["repo", "project", "workflow"],
  needsReconnect: false,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

function stubConnectors(connectors: Array<Record<string, unknown>>) {
  return http.get("http://localhost:3000/api/zero/connectors", () => {
    return HttpResponse.json({
      connectors,
      configuredTypes: connectors.map((c) => {
        return c.type as string;
      }),
    });
  });
}

function stubAgent(id: string, displayName: string | null) {
  return http.get(`http://localhost:3000/api/zero/agents/${id}`, () => {
    return HttpResponse.json({
      agentId: id,
      ownerId: "owner-1",
      description: null,
      displayName,
      sound: null,
      avatarUrl: null,
      permissionPolicies: null,
      customSkills: [],
    });
  });
}

function stubUserConnectors(id: string, enabledTypes: string[]) {
  return http.get(
    `http://localhost:3000/api/zero/agents/${id}/user-connectors`,
    () => {
      return HttpResponse.json({ enabledTypes });
    },
  );
}

function stubAvailableConnectors(types: string[]) {
  return http.get("http://localhost:3000/api/zero/connectors/search", () => {
    return HttpResponse.json({
      connectors: types.map((type) => {
        return {
          id: type,
          label: type,
          description: type,
          authMethods: ["oauth"],
        };
      }),
    });
  });
}

describe("zero connector list command", () => {
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

  describe("without agent context", () => {
    it("renders TYPE and CONNECTED AS columns for a connected connector", async () => {
      server.use(stubConnectors([connectedGithub]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("TYPE");
      expect(logCalls).toContain("CONNECTED AS");
      expect(logCalls).not.toContain("ACCOUNT");
      expect(logCalls).not.toContain("STATUS");
      expect(logCalls).not.toContain("AUTHORIZED FOR");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("@octocat");
    });

    it("renders (not connected) for types with no connector", async () => {
      server.use(stubConnectors([]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("(not connected)");
      expect(logCalls).not.toContain("@octocat");
    });

    it("renders reconnect-needed state", async () => {
      server.use(
        stubConnectors([{ ...connectedGithub, needsReconnect: true }]),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("@octocat (reconnect needed)");
    });
  });

  describe("with agent context", () => {
    it("renders AUTHORIZED FOR column with displayName when --agent is provided", async () => {
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("AUTHORIZED FOR maya");
      expect(logCalls).toContain("✓");
    });

    it("renders AUTHORIZED FOR column when $ZERO_AGENT_ID is set", async () => {
      vi.stubEnv("ZERO_AGENT_ID", AGENT_UUID);
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("AUTHORIZED FOR maya");
      expect(logCalls).toContain("✓");
    });

    it("--agent overrides $ZERO_AGENT_ID", async () => {
      vi.stubEnv("ZERO_AGENT_ID", ALT_AGENT_UUID);
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
        http.get(
          `http://localhost:3000/api/zero/agents/${ALT_AGENT_UUID}`,
          () => {
            return HttpResponse.json(
              { error: { message: "should not be called", code: "ERR" } },
              { status: 500 },
            );
          },
        ),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("AUTHORIZED FOR maya");
    });

    it("falls back to agent UUID when displayName is null", async () => {
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, null),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`AUTHORIZED FOR ${AGENT_UUID}`);
    });

    it("renders - for connectors the agent is not authorized for", async () => {
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("AUTHORIZED FOR maya");
      expect(logCalls).not.toContain("✓");
      expect(logCalls).toContain("-");
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/connectors", () => {
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
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("strictFeatureFlag filtering", () => {
    it("excludes zapier when ZapierConnector feature switch is disabled (default)", async () => {
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "test"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("zapier");
    });

    it("includes connectors with api-token auth and no strictFeatureFlag even when their flag is disabled", async () => {
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "test"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      // mercury has api-token auth and no strictFeatureFlag so it is always visible
      expect(logCalls).toContain("mercury");
    });

    it("uses the server-visible catalog for feature-gated oauth connectors", async () => {
      server.use(stubConnectors([]), stubAvailableConnectors(["google-ads"]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("google-ads");
    });
  });

  describe("alias", () => {
    it("should have ls alias", () => {
      expect(listCommand.alias()).toBe("ls");
    });
  });
});
