/**
 * Tests for zero doctor firewall-deny command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Real (internal): All CLI code, firewall configs from @vm0/core
 * - No external API calls — this command only reads local firewall config
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { firewallDenyCommand } from "../firewall-deny";

describe("zero doctor firewall-deny command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("known ref with matching permission", () => {
    it("should output permission name and URL for a matching request", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--method",
        "GET",
        "--path",
        "/repos/owner/repo/pulls",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "GitHub firewall blocked GET /repos/owner/repo/pulls",
      );
      expect(logCalls).toContain('covered by the "');
      expect(logCalls).toMatch(
        /\[Allow GitHub access\]\(https:\/\/app\.vm0\.ai\/firewall-allow\/agent-abc-123\?/,
      );
      expect(logCalls).toContain("ref=github");
      expect(logCalls).toContain("permission=");
    });
  });

  describe("known ref with no matching permission", () => {
    it("should output URL without permission param for unmatched path", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--method",
        "DELETE",
        "--path",
        "/some/nonexistent/endpoint/that/will/never/match",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("GitHub firewall blocked DELETE");
      expect(logCalls).toContain("No named permission was found");
      expect(logCalls).not.toContain("permission=");
    });
  });

  describe("unknown ref", () => {
    it("should exit with error for unrecognized firewall ref", async () => {
      await expect(async () => {
        await firewallDenyCommand.parseAsync([
          "node",
          "cli",
          "unknown_service",
          "--method",
          "GET",
          "--path",
          "/foo",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Unknown firewall connector type: unknown_service",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("URL transformation", () => {
    it("should transform www.vm0.ai to app.vm0.ai", async () => {
      vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--method",
        "GET",
        "--path",
        "/repos/owner/repo/pulls",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("https://app.vm0.ai/firewall-allow/agent-1?");
    });

    it("should transform tunnel -www suffix to -app", async () => {
      vi.stubEnv("VM0_API_URL", "https://tunnel-yuma-vm0-www.vm7.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--method",
        "GET",
        "--path",
        "/repos/owner/repo/pulls",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "https://tunnel-yuma-vm0-app.vm7.ai/firewall-allow/agent-1?",
      );
    });
  });

  describe("ZERO_AGENT_ID presence/absence", () => {
    it("should use /firewall-allow/:agentId when ZERO_AGENT_ID is set", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "my-agent-id");

      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--method",
        "GET",
        "--path",
        "/repos/owner/repo/pulls",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("/firewall-allow/my-agent-id?");
    });

    it("should use /firewall-allow when ZERO_AGENT_ID is not set", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "");

      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--method",
        "GET",
        "--path",
        "/repos/owner/repo/pulls",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("/firewall-allow?");
      expect(logCalls).not.toContain("/firewall-allow/");
    });
  });
});
