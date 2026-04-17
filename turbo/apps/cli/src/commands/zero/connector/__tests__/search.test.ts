/**
 * Tests for zero connector search command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, scoring algorithm, formatters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { searchCommand } from "../search";
import chalk from "chalk";

const AGENT_UUID = "550e8400-e29b-41d4-a716-446655440000";
const ALT_AGENT_UUID = "550e8400-e29b-41d4-a716-446655440099";

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

function findDataRows(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("TYPE")) return false;
    if (trimmed.startsWith("No exact match")) return false;
    if (trimmed.startsWith("Too many results")) return false;
    if (trimmed.startsWith("No matches found")) return false;
    return true;
  });
}

describe("zero connector search command", () => {
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

  describe("keyword validation", () => {
    it("rejects whitespace-only keyword", async () => {
      await expect(async () => {
        await searchCommand.parseAsync(["node", "cli", "   "]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Keyword cannot be empty"),
      );
    });
  });

  describe("without agent context", () => {
    it("returns github first for an exact type match with no banner", async () => {
      await searchCommand.parseAsync(["node", "cli", "github"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).not.toContain("No exact match");
      expect(output).not.toContain("Too many results");
      expect(output).not.toContain("AUTHORIZED FOR");

      const dataRows = findDataRows(lines);
      expect(dataRows[0]).toMatch(/^github\s/);
    });

    it("returns github for an env var exact match (GH_TOKEN)", async () => {
      await searchCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).not.toContain("No exact match");
      const dataRows = findDataRows(lines);
      expect(dataRows[0]).toMatch(/^github\s/);
    });

    it("returns github with No-exact-match banner for tag match GH_API_KEY", async () => {
      await searchCommand.parseAsync(["node", "cli", "GH_API_KEY"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("No exact match. Showing closest:");
      const dataRows = findDataRows(lines);
      expect(dataRows[0]).toMatch(/^github\s/);
    });

    it("matches multiple connectors by shared tag vcs", async () => {
      await searchCommand.parseAsync(["node", "cli", "vcs"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("No exact match. Showing closest:");
      const dataRows = findDataRows(lines);
      const types = dataRows.map((row) => {
        return row.split(/\s+/)[0];
      });
      expect(types).toContain("github");
      expect(types).toContain("gitlab");
    });

    it("ranks tag-exact above type-substring above tag-substring", async () => {
      // Keyword "chat" exercises three scoring tiers against the real catalog
      // and pins the priority ordering contract so future refactors of
      // scoreConnector cannot silently reorder them:
      //   - slack:    tag-exact "chat"             => 70
      //   - chatwoot: type-substring "chatwoot"    => 50
      //   - openai:   tag-substring "chatgpt"      => 25
      await searchCommand.parseAsync(["node", "cli", "chat", "--limit", "10"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const dataRows = findDataRows(lines);
      const types = dataRows.map((row) => {
        return row.split(/\s+/)[0];
      });
      const slackIdx = types.indexOf("slack");
      const chatwootIdx = types.indexOf("chatwoot");
      const openaiIdx = types.indexOf("openai");
      expect(slackIdx).toBe(0);
      expect(chatwootIdx).toBeGreaterThan(slackIdx);
      expect(openaiIdx).toBeGreaterThan(chatwootIdx);
    });

    it("prints No matches found for an unknown keyword", async () => {
      await searchCommand.parseAsync(["node", "cli", "xyz123abc"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("No matches found.");
      const dataRows = findDataRows(lines);
      expect(dataRows).toHaveLength(0);
    });

    it("caps at --limit and prefixes with Too many results", async () => {
      await searchCommand.parseAsync(["node", "cli", "api", "--limit", "3"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toMatch(/Too many results \(top 3 of \d+\):/);
      const dataRows = findDataRows(lines);
      expect(dataRows).toHaveLength(3);
    });

    it("rejects a non-positive --limit", async () => {
      await expect(async () => {
        await searchCommand.parseAsync([
          "node",
          "cli",
          "github",
          "--limit",
          "0",
        ]);
      }).rejects.toThrow();
    });
  });

  describe("with agent context", () => {
    it("adds AUTHORIZED FOR column when --agent is provided", async () => {
      server.use(
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await searchCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("AUTHORIZED FOR maya");
      const githubRow = findDataRows(lines).find((line) => {
        return line.startsWith("github");
      });
      expect(githubRow).toMatch(/✓/);
    });

    it("adds AUTHORIZED FOR column when ZERO_AGENT_ID is set", async () => {
      vi.stubEnv("ZERO_AGENT_ID", AGENT_UUID);
      server.use(
        stubAgent(AGENT_UUID, "maya"),
        stubUserConnectors(AGENT_UUID, []),
      );

      await searchCommand.parseAsync(["node", "cli", "github"]);

      const lines = mockConsoleLog.mock.calls.flat() as string[];
      const output = lines.join("\n");
      expect(output).toContain("AUTHORIZED FOR maya");
      const githubRow = findDataRows(lines).find((line) => {
        return line.startsWith("github");
      });
      expect(githubRow).toMatch(/-/);
    });

    it("uses the full UUID as the header when displayName is null", async () => {
      server.use(
        stubAgent(AGENT_UUID, null),
        stubUserConnectors(AGENT_UUID, []),
      );

      await searchCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const output = (mockConsoleLog.mock.calls.flat() as string[]).join("\n");
      expect(output).toContain(`AUTHORIZED FOR ${AGENT_UUID}`);
    });

    it("--agent overrides ZERO_AGENT_ID", async () => {
      vi.stubEnv("ZERO_AGENT_ID", ALT_AGENT_UUID);
      server.use(
        stubAgent(AGENT_UUID, "from-flag"),
        stubUserConnectors(AGENT_UUID, ["github"]),
      );

      await searchCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--agent",
        AGENT_UUID,
      ]);

      const output = (mockConsoleLog.mock.calls.flat() as string[]).join("\n");
      expect(output).toContain("AUTHORIZED FOR from-flag");
      expect(output).not.toContain(ALT_AGENT_UUID);
    });
  });
});
