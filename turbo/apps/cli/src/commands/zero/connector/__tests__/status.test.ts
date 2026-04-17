/**
 * Tests for zero connector status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { statusCommand } from "../status";
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
  oauthScopes: ["repo", "project"],
  needsReconnect: false,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

function stubConnector(body: Record<string, unknown>, status = 200) {
  return http.get("http://localhost:3000/api/zero/connectors/:type", () => {
    return HttpResponse.json(body, { status });
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

describe("zero connector status command", () => {
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
    it("displays connected status with details", async () => {
      server.use(stubConnector(connectedGithub));

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("connected");
      expect(logCalls).toContain("@octocat");
      expect(logCalls).toContain("oauth");
      expect(logCalls).not.toContain("Authorized:");
    });

    it("displays not connected status", async () => {
      server.use(
        stubConnector(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          404,
        ),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("not connected");
      expect(logCalls).not.toContain("Authorized:");
    });
  });

  describe("with agent context", () => {
    it("shows Authorized: ✓ when agent is authorized", async () => {
      server.use(
        stubConnector(connectedGithub),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Authorized:");
      expect(logCalls).toContain("✓ for agent maya");
      expect(logCalls).not.toContain("Authorize:");
    });

    it("shows Authorized: - and authorize URL when connected but not authorized", async () => {
      server.use(
        stubConnector(connectedGithub),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("- for agent maya");
      expect(logCalls).toContain("Authorize:");
      expect(logCalls).toContain(
        `/connectors/github/authorize?agentId=${AGENT_UUID}`,
      );
    });

    it("shows Authorized: - and authorize URL when connector not connected", async () => {
      server.use(
        stubConnector(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          404,
        ),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("not connected");
      expect(logCalls).toContain("- for agent maya");
      expect(logCalls).toContain(
        `/connectors/github/authorize?agentId=${AGENT_UUID}`,
      );
    });

    it("uses $ZERO_AGENT_ID when --agent flag is not provided", async () => {
      vi.stubEnv("ZERO_AGENT_ID", AGENT_UUID);
      server.use(
        stubConnector(connectedGithub),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await statusCommand.parseAsync(["node", "cli", "github"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("✓ for agent maya");
    });

    it("--agent overrides $ZERO_AGENT_ID", async () => {
      vi.stubEnv("ZERO_AGENT_ID", ALT_AGENT_UUID);
      server.use(
        stubConnector(connectedGithub),
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

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("✓ for agent maya");
    });

    it("falls back to UUID when displayName is null", async () => {
      server.use(
        stubConnector(connectedGithub),
        stubAgent(AGENT_UUID, null),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(`✓ for agent ${AGENT_UUID}`);
    });
  });

  describe("input validation", () => {
    it("should reject invalid connector type", async () => {
      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "invalid-type"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown connector type: invalid-type"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Available connectors:"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        stubConnector(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          401,
        ),
      );

      await expect(async () => {
        await statusCommand.parseAsync(["node", "cli", "github"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
