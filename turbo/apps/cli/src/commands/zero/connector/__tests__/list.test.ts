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
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";

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
  connectionStatus: "connected",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

function statusItemFromConnector(connector: Record<string, unknown>) {
  return catalogStatusItem({
    connectorSlug: connector.type as string,
    authMethods: [authCodeMethod(connector.authMethod as string)],
    connection: {
      authMethod: connector.authMethod as string,
      externalUsername: (connector.externalUsername as string | null) ?? null,
      externalEmail: (connector.externalEmail as string | null) ?? null,
      reconnectReason: null,
    },
    connected: true,
    connectionStatus:
      (connector.connectionStatus as "connected" | "reconnect-required") ??
      "connected",
  });
}

function stubConnectors(connectors: Array<Record<string, unknown>>) {
  const connectedBySlug = new Map(
    connectors.map((connector) => {
      return [connector.type as string, statusItemFromConnector(connector)];
    }),
  );
  const visibleConnectorSlugs = new Set([
    "github",
    "mercury",
    ...connectedBySlug.keys(),
  ]);
  return stubConnectorCatalogStatus(
    [...visibleConnectorSlugs].map((connectorSlug) => {
      return (
        connectedBySlug.get(connectorSlug) ??
        catalogStatusItem({
          connectorSlug,
          authMethods: [authCodeMethod("oauth")],
        })
      );
    }),
  );
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
    });
  });
}

function stubUserConnectors(id: string, enabledConnectorSlugs: string[]) {
  return http.get(
    `http://localhost:3000/api/zero/agents/${id}/user-connectors`,
    () => {
      return HttpResponse.json({ enabledTypes: enabledConnectorSlugs });
    },
  );
}

function stubAvailableConnectors(connectorSlugs: string[]) {
  return stubConnectorCatalogStatus(
    connectorSlugs.map((connectorSlug) => {
      return catalogStatusItem({
        connectorSlug,
        authMethods: [authCodeMethod("oauth")],
      });
    }),
  );
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
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
    server.use(stubCustomConnectors([]), stubAgentCustomConnectors([]));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("without agent context", () => {
    it("renders SLUG and CONNECTED AS columns for a connected connector", async () => {
      server.use(stubConnectors([connectedGithub]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("SLUG");
      expect(logCalls).toContain("CONNECTED AS");
      expect(logCalls).not.toContain("ACCOUNT");
      expect(logCalls).not.toContain("STATUS");
      expect(logCalls).not.toContain("AUTHORIZED FOR");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("@octocat");
    });

    it("prefers canonical catalog slugs and falls back to legacy-only responses", async () => {
      server.use(
        stubConnectorCatalogStatus([
          {
            ...catalogStatusItem({ connectorSlug: "legacy-canonical" }),
            slug: "canonical",
          },
          {
            ...catalogStatusItem({ connectorSlug: "legacy-only" }),
            slug: undefined,
          },
        ]),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("canonical");
      expect(logCalls).toContain("legacy-only");
      expect(logCalls).not.toContain("legacy-canonical");
    });

    it("renders (not connected) for slugs with no connector", async () => {
      server.use(stubConnectors([]));

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
      expect(logCalls).toContain("(not connected)");
      expect(logCalls).not.toContain("@octocat");
    });

    it("renders reconnect-needed state", async () => {
      server.use(
        stubConnectors([
          { ...connectedGithub, connectionStatus: "reconnect-required" },
        ]),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("@octocat (reconnect needed)");
    });

    it("renders custom connectors with their connection status", async () => {
      server.use(
        stubAvailableConnectors(["github"]),
        stubCustomConnectors([
          customConnector({
            connected: true,
            missingRequiredFields: [],
            configuredFieldKeys: ["secret:apiKey"],
            hasSecret: true,
          }),
          customConnector({
            id: "44444444-4444-4444-8444-444444444444",
            slug: "_weather-api",
            displayName: "Weather API",
          }),
        ]),
      );

      await listCommand.parseAsync(["node", "cli"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const connectedRow = lines.find((line) => {
        return line.startsWith("_acme-search");
      });
      const missingRow = lines.find((line) => {
        return line.startsWith("_weather-api");
      });
      expect(connectedRow).toContain("connected");
      expect(missingRow).toContain("missing apiKey");
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

    it("prefers canonical enabled connector slugs", async () => {
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "maya"),
        http.get(
          `http://localhost:3000/api/zero/agents/${AGENT_UUID}/user-connectors`,
          () => {
            return HttpResponse.json({
              enabledTypes: [],
              enabledConnectorSlugs: ["github"],
            });
          },
        ),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("github");
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

    it("renders custom connector authorization for the agent", async () => {
      const connector = customConnector();
      server.use(
        stubAvailableConnectors(["github"]),
        stubCustomConnectors([connector]),
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
        stubAgentCustomConnectors([connector.id]),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const customRow = (mockConsoleLog.mock.calls.flat() as string[]).find(
        (line) => {
          return line.startsWith(connector.slug);
        },
      );
      expect(customRow).toMatch(/✓$/u);
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/zero/connector-catalog/status",
          () => {
            return HttpResponse.json(
              {
                error: {
                  message: "Not authenticated",
                  code: "UNAUTHORIZED",
                },
              },
              { status: 401 },
            );
          },
        ),
      );

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Authentication failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("auth method feature flag filtering", () => {
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

    it("includes connectors with ungated api-token auth even when oauth is feature-gated", async () => {
      server.use(
        stubConnectors([connectedGithub]),
        stubAgent(AGENT_UUID, "test"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await listCommand.parseAsync(["node", "cli", "--agent", AGENT_UUID]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      // mercury has an ungated api-token auth method, so it is always visible.
      expect(logCalls).toContain("mercury");
    });

    it("uses the server-visible catalog for feature-gated oauth connectors", async () => {
      server.use(stubAvailableConnectors(["google-ads"]));

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
