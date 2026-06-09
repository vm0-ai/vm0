/**
 * Tests for zero doctor permission-deny command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Real (internal): All CLI code, firewall configs from @vm0/core
 *
 * permission-deny is a pure diagnostic command — it identifies which permission
 * covers a denied request and tells the agent to run permission-change.
 * It does not generate platform URLs.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { permissionDenyCommand } from "../permission-deny";

describe("zero doctor permission-deny command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockConsoleDebug = vi
    .spyOn(console, "debug")
    .mockImplementation(() => {});

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockConsoleDebug.mockClear();
  });

  describe("known ref with matching permission", () => {
    it("should output permission name and next-step command", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--path",
        "/conversations.list",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "Slack permission filtered GET /conversations.list",
      );
      expect(logCalls).toContain('covered by the "');
      expect(logCalls).toContain(
        "zero doctor permission-change slack --permission",
      );
      expect(logCalls).toContain("--enable");
      expect(logCalls).toContain("--duration 1h");
      expect(logCalls).not.toContain("--reason");
      expect(mockConsoleDebug).not.toHaveBeenCalled();
    });
  });

  describe("known ref with no matching permission", () => {
    it("should output no-permission message", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "DELETE",
        "--path",
        "/some/nonexistent/endpoint/that/will/never/match",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Slack permission filtered DELETE");
      expect(logCalls).toContain("No named permission was found");
      expect(logCalls).not.toContain("permission-change");
    });
  });

  describe("unknown ref", () => {
    it("should exit with error for unrecognized connector ref", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
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
        expect.stringContaining("Unknown connector type: unknown_service"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("slack matching", () => {
    it("should identify chat:write for POST /chat.postMessage", async () => {
      await permissionDenyCommand.parseAsync([
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
        "Slack permission filtered POST /chat.postMessage",
      );
      expect(logCalls).toContain('covered by the "chat:write"');
      expect(logCalls).toContain(
        "zero doctor permission-change slack --permission chat:write --enable --duration 1h",
      );
    });
  });

  describe("overlapping permissions", () => {
    it("should pick the most specific (narrowest) permission for gmail send", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "gmail",
        "--method",
        "POST",
        "--path",
        "/v1/users/me/messages/send",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('covered by the "gmail.send"');
      expect(logCalls).toContain(
        "--permission gmail.send --enable --duration 1h",
      );
    });
  });

  describe("next-step command format", () => {
    it("should include the exact connector ref in the suggested command", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--path",
        "/conversations.list",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      // The suggested command should contain the ref, permission, and --enable.
      expect(logCalls).toMatch(
        /zero doctor permission-change slack --permission \S+ --enable --duration 1h/,
      );
      expect(logCalls).not.toContain("--reason");
    });

    it("should not suggest permission-change when no permission matches", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "PATCH",
        "--path",
        "/totally/unknown/endpoint",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("permission-change");
      expect(logCalls).not.toContain("--reason");
    });

    it("should not generate any platform URL", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--path",
        "/conversations.list",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("app.vm0.ai");
      expect(logCalls).not.toContain("[Manage");
      expect(logCalls).not.toContain("[Request");
    });
  });
});
