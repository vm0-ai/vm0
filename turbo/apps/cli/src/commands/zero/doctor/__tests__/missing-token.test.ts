/**
 * Tests for zero doctor missing-token command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): None (no API calls — purely local mapping)
 * - Real (internal): All CLI code, connector mappings from @vm0/core
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { missingTokenCommand } from "../missing-token";
import chalk from "chalk";

describe("zero doctor missing-token command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("known token", () => {
    it("should output connector name and settings URL", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "GH_TOKEN is provided by the GitHub connector",
      );
      expect(logCalls).toContain(
        "https://app.vm0.ai/team/agent-abc-123?tab=connectors",
      );
    });

    it("should include ZERO_AGENT_ID in URL when set", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "test-agent-456");

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("/team/test-agent-456?tab=connectors");
    });

    it("should fall back to generic URL when ZERO_AGENT_ID is not set", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "");

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.vm0.ai/team?tab=connectors");
    });

    it("should transform www.vm0.ai to app.vm0.ai", async () => {
      vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "https://app.vm0.ai/team/agent-1?tab=connectors",
      );
    });

    it("should use custom VM0_API_URL with app prefix", async () => {
      vi.stubEnv("VM0_API_URL", "https://custom.example.com");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.custom.example.com/team/agent-1");
    });
  });

  describe("unknown token", () => {
    it("should exit with error for unrecognized token", async () => {
      await expect(async () => {
        await missingTokenCommand.parseAsync([
          "node",
          "cli",
          "UNKNOWN_FOO_TOKEN",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown token: UNKNOWN_FOO_TOKEN"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
