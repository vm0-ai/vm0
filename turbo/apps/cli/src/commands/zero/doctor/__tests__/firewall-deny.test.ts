/**
 * Tests for zero doctor firewall-deny command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Real (internal): All CLI code, firewall configs from @vm0/core
 *
 * firewall-deny is a pure diagnostic command — it identifies which permission
 * covers a denied request and tells the agent to run firewall-permissions-change.
 * It does NOT resolve roles or generate platform URLs.
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
    it("should output permission name and next-step command", async () => {
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
      expect(logCalls).toContain(
        "zero doctor firewall-permissions-change github --permission",
      );
      expect(logCalls).toContain("--enable --reason");
    });
  });

  describe("known ref with no matching permission", () => {
    it("should output no-permission message", async () => {
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
      expect(logCalls).not.toContain("firewall-permissions-change");
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

  describe("slack matching", () => {
    it("should identify chat:write for POST /chat.postMessage", async () => {
      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "POST",
        "--path",
        "/chat.postMessage",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "Slack firewall blocked POST /chat.postMessage",
      );
      expect(logCalls).toContain('covered by the "chat:write"');
      expect(logCalls).toContain(
        "zero doctor firewall-permissions-change slack --permission chat:write --enable",
      );
    });
  });

  describe("next-step command format", () => {
    it("should include the exact firewall ref in the suggested command", async () => {
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
      // The suggested command should contain the ref, permission, --enable, and --reason placeholder
      expect(logCalls).toMatch(
        /zero doctor firewall-permissions-change github --permission \S+ --enable --reason/,
      );
    });

    it("should not suggest firewall-permissions-change when no permission matches", async () => {
      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--method",
        "PATCH",
        "--path",
        "/totally/unknown/endpoint",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("firewall-permissions-change");
      expect(logCalls).not.toContain("--reason");
    });

    it("should not generate any platform URL", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
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
      expect(logCalls).not.toContain("app.vm0.ai");
      expect(logCalls).not.toContain("[Manage");
      expect(logCalls).not.toContain("[Request");
    });
  });
});
