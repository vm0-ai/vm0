/**
 * Tests for zero doctor missing-token command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): API calls (getZeroConnector, getZeroAgentUserConnectors)
 * - Real (internal): All CLI code, connector mappings from @vm0/core
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { missingTokenCommand } from "../missing-token";
import chalk from "chalk";

vi.mock("../../../../lib/api/domains/zero-connectors", () => ({
  getZeroConnector: vi.fn(),
}));

vi.mock("../../../../lib/api/domains/zero-agents", () => ({
  getZeroAgentUserConnectors: vi.fn(),
}));

import { getZeroConnector } from "../../../../lib/api/domains/zero-connectors";
import { getZeroAgentUserConnectors } from "../../../../lib/api/domains/zero-agents";

const mockGetZeroConnector = vi.mocked(getZeroConnector);
const mockGetUserConnectors = vi.mocked(getZeroAgentUserConnectors);

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
    mockGetZeroConnector.mockReset();
    mockGetUserConnectors.mockReset();
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("connector not connected", () => {
    it("should direct to connectors tab when connector is not connected", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      mockGetZeroConnector.mockResolvedValue(null);
      mockGetUserConnectors.mockResolvedValue([]);

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "GH_TOKEN is provided by the GitHub connector",
      );
      expect(logCalls).toContain("not connected");
      expect(logCalls).toContain("https://app.vm0.ai/connectors");
    });
  });

  describe("connector connected but no permission", () => {
    it("should direct to authorization tab when connector is connected but not authorized", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      mockGetZeroConnector.mockResolvedValue({
        type: "github",
        authMethod: "oauth",
        connected: true,
      } as never);
      mockGetUserConnectors.mockResolvedValue(["slack"]);

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "GH_TOKEN is provided by the GitHub connector",
      );
      expect(logCalls).toContain("not authorized");
      expect(logCalls).toContain(
        "https://app.vm0.ai/team/agent-abc-123?tab=authorization",
      );
    });
  });

  describe("connector connected and authorized", () => {
    it("should report unexpected state when both are fine", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      mockGetZeroConnector.mockResolvedValue({
        type: "github",
        authMethod: "oauth",
        connected: true,
      } as never);
      mockGetUserConnectors.mockResolvedValue(["github", "slack"]);

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("connected and authorized");
      expect(logCalls).toContain("still missing");
    });
  });

  describe("URL transformation", () => {
    it("should transform www.vm0.ai to app.vm0.ai", async () => {
      vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");
      mockGetZeroConnector.mockResolvedValue(null);
      mockGetUserConnectors.mockResolvedValue([]);

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.vm0.ai/connectors");
    });

    it("should transform tunnel -www suffix to -app", async () => {
      vi.stubEnv("VM0_API_URL", "https://tunnel-yuma-vm0-www.vm7.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");
      mockGetZeroConnector.mockResolvedValue(null);
      mockGetUserConnectors.mockResolvedValue([]);

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "https://tunnel-yuma-vm0-app.vm7.ai/connectors",
      );
    });

    it("should fall back to generic URL when ZERO_AGENT_ID is not set", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "");
      mockGetZeroConnector.mockResolvedValue(null);
      mockGetUserConnectors.mockResolvedValue(null as never);

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.vm0.ai/connectors");
    });

    it("should use custom VM0_API_URL with app prefix", async () => {
      vi.stubEnv("VM0_API_URL", "https://custom.example.com");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");
      mockGetZeroConnector.mockResolvedValue(null);
      mockGetUserConnectors.mockResolvedValue([]);

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.custom.example.com/connectors");
    });
  });

  describe("API errors are gracefully handled", () => {
    it("should treat connector as not connected when API call fails", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");
      mockGetZeroConnector.mockRejectedValue(new Error("network error"));
      mockGetUserConnectors.mockRejectedValue(new Error("network error"));

      await missingTokenCommand.parseAsync(["node", "cli", "GH_TOKEN"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("not connected");
      expect(logCalls).toContain("/connectors");
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
