/**
 * Tests for zero doctor permission-deny command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Real (internal): All CLI code, routing metadata from @vm0/connectors
 *
 * permission-deny is a pure diagnostic command — it identifies which permission
 * or unknown endpoint policy covers a denied request and tells the agent to run permission-change.
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
        "--url",
        "https://slack.com/api/conversations.list",
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
        "--url",
        "https://slack.com/api/some/nonexistent/endpoint/that/will/never/match",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Slack permission filtered DELETE");
      expect(logCalls).toContain("No named permission was found");
      expect(logCalls).toContain(
        "zero doctor permission-change slack --permission __unknown__ --enable --duration 1h",
      );
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
          "--url",
          "https://api.example.com/foo",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown connector type: unknown_service"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("computer-use capability denials", () => {
    it("should explain selected-host token grants for computer-use ref", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "computer-use",
        "--method",
        "POST",
        "--url",
        "https://zero.local/computer-use/list-apps",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "Computer Use access is not managed as a connector permission.",
      );
      expect(logCalls).toContain("selected for the chat or thread");
      expect(logCalls).toContain("Existing run tokens cannot be upgraded");
      expect(logCalls).toContain("zero whoami");
      expect(mockConsoleError).not.toHaveBeenCalled();
    });

    it("should recognize computer-use paths before connector validation", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "agent",
        "--method",
        "POST",
        "--url",
        "https://zero.local/computer-use/list-apps",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "Computer Use access is not managed as a connector permission.",
      );
      expect(mockConsoleError).not.toHaveBeenCalled();
    });

    it("should not treat similar path prefixes as computer-use", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "agent",
          "--method",
          "POST",
          "--url",
          "https://zero.local/computer-useful/list-apps",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown connector type: agent"),
      );
      expect(mockConsoleLog).not.toHaveBeenCalledWith(
        expect.stringContaining(
          "Computer Use access is not managed as a connector permission.",
        ),
      );
    });

    it("should not normalize encoded dot segments into computer-use guidance", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "agent",
          "--method",
          "POST",
          "--url",
          "https://zero.local/not-computer/%2e%2e/computer-use/list-apps",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "permission-deny cannot diagnose unsafe URL paths because they are blocked before permission policy evaluation.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalledWith(
        expect.stringContaining(
          "Computer Use access is not managed as a connector permission.",
        ),
      );
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
        "--url",
        "https://slack.com/api/chat.postMessage",
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
        "--url",
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('covered by the "messages.send"');
      expect(logCalls).toContain(
        "--permission messages.send --enable --duration 1h",
      );
    });
  });

  describe("base-aware URL matching", () => {
    it("should identify videos.write for the normal YouTube metadata update base", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "youtube",
        "--method",
        "PUT",
        "--url",
        "https://youtube.googleapis.com/youtube/v3/videos",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "YouTube permission filtered PUT /v3/videos relative to base URL https://youtube.googleapis.com/youtube",
      );
      expect(logCalls).toContain('covered by the "videos.write"');
      expect(logCalls).toContain(
        "zero doctor permission-change youtube --permission videos.write --enable --duration 1h",
      );
    });

    it("should not report normal-base videos.write for the YouTube upload base", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "youtube",
        "--method",
        "PUT",
        "--url",
        "https://youtube.googleapis.com/upload/youtube/v3/videos",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "YouTube permission filtered PUT /v3/videos relative to base URL https://youtube.googleapis.com/upload/youtube",
      );
      expect(logCalls).not.toContain('"videos.write"');
      expect(
        logCalls.includes("No named permission was found") ||
          logCalls.includes('"videos.create"'),
      ).toBe(true);
    });

    it("should match base URL templates with path variables", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "quickbooks",
        "--method",
        "GET",
        "--url",
        "https://quickbooks.api.intuit.com/v3/company/123/companyinfo/123",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "QuickBooks permission filtered GET /companyinfo/123 relative to base URL https://quickbooks.api.intuit.com/v3/company/${{ vars.QUICKBOOKS_REALM_ID }}",
      );
      expect(logCalls).toContain('covered by the "company-info"');
      expect(logCalls).toContain(
        "zero doctor permission-change quickbooks --permission company-info --enable --duration 1h",
      );
    });

    it("should use configured env base URL variables when available", async () => {
      vi.stubEnv("REAP_API_BASE_URL", "https://sandbox.api.reap.global/v1");

      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "reap",
        "--method",
        "GET",
        "--url",
        "https://sandbox.api.reap.global/v1/accounts",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "Reap permission filtered GET /accounts relative to base URL https://sandbox.api.reap.global/v1",
      );
      expect(logCalls).toContain('covered by the "read"');
      expect(logCalls).toContain(
        "zero doctor permission-change reap --permission read --enable --duration 1h",
      );
    });

    it("should diagnose single opaque base URL variable connectors without env", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "reap",
        "--method",
        "GET",
        "--url",
        "https://sandbox.api.reap.global/v1/accounts",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "Reap permission filtered GET /v1/accounts relative to base URL ${{ vars.REAP_API_BASE_URL }}",
      );
      expect(logCalls).toContain('covered by the "read"');
      expect(logCalls).toContain(
        "zero doctor permission-change reap --permission read --enable --duration 1h",
      );
    });

    it("should not use opaque base fallback when configured env mismatches", async () => {
      vi.stubEnv("REAP_API_BASE_URL", "https://api.reap.global/v1");

      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "reap",
          "--method",
          "GET",
          "--url",
          "https://sandbox.api.reap.global/v1/accounts",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "No registered Reap base URL matches the provided URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should not use opaque base fallback for unrelated hosts", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "reap",
          "--method",
          "GET",
          "--url",
          "https://example.com/v1/accounts",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "No registered Reap base URL matches the provided URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should not use opaque base fallback for connector substrings in host labels", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "reap",
          "--method",
          "GET",
          "--url",
          "https://notreap.example.com/v1/accounts",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "No registered Reap base URL matches the provided URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should not use opaque base fallback for connector labels outside the registered domain position", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "reap",
          "--method",
          "GET",
          "--url",
          "https://reap.example.com/v1/accounts",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "No registered Reap base URL matches the provided URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should preserve raw encoded paths for opaque base fallback", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "reap",
        "--method",
        "GET",
        "--url",
        "https://sandbox.api.reap.global/v1/%7Eraw/accounts?token=secret",
      ]);

      const output = [
        ...mockConsoleLog.mock.calls.flat(),
        ...mockConsoleError.mock.calls.flat(),
      ].join("\n");
      expect(output).toContain(
        "Reap permission filtered GET /v1/%7Eraw/accounts relative to base URL ${{ vars.REAP_API_BASE_URL }}",
      );
      expect(output).toContain('covered by the "read"');
      expect(output).not.toContain("secret");
      expect(output).not.toContain("token=");
    });

    it("should reject unsafe encoded dot segments before permission guidance", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "reap",
          "--method",
          "GET",
          "--url",
          "https://sandbox.api.reap.global/v1/%2e%2e/accounts?token=secret",
        ]);
      }).rejects.toThrow("process.exit called");

      const output = [
        ...mockConsoleLog.mock.calls.flat(),
        ...mockConsoleError.mock.calls.flat(),
      ].join("\n");
      expect(output).toContain(
        "permission-deny cannot diagnose unsafe URL paths because they are blocked before permission policy evaluation.",
      );
      expect(output).not.toContain('covered by the "read"');
      expect(output).not.toContain("secret");
      expect(output).not.toContain("token=");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject raw path backslashes as unsafe paths", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "reap",
          "--method",
          "GET",
          "--url",
          "https://sandbox.api.reap.global/v1\\accounts?token=secret",
        ]);
      }).rejects.toThrow("process.exit called");

      const output = [
        ...mockConsoleLog.mock.calls.flat(),
        ...mockConsoleError.mock.calls.flat(),
      ].join("\n");
      expect(output).toContain(
        "permission-deny cannot diagnose unsafe URL paths because they are blocked before permission policy evaluation.",
      );
      expect(output).not.toContain('covered by the "read"');
      expect(output).not.toContain("secret");
      expect(output).not.toContain("token=");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should not ignore configured env base URL variable mismatches", async () => {
      vi.stubEnv("QUICKBOOKS_REALM_ID", "999");

      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "quickbooks",
          "--method",
          "GET",
          "--url",
          "https://quickbooks.api.intuit.com/v3/company/123/companyinfo/123",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "No registered QuickBooks base URL matches the provided URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should reject path-only diagnostics", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "youtube",
          "--method",
          "PUT",
          "--path",
          "/v3/videos",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "permission-deny now requires --url because method/path alone can match the wrong API base.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should reject malformed URLs before computer-use guidance", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "computer-use",
          "--method",
          "POST",
          "--url",
          "not-a-url",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "permission-deny requires --url to be a valid absolute http or https URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should reject non-http URLs", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--method",
          "GET",
          "--url",
          "mailto:user@example.com",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "permission-deny requires --url to be a valid absolute http or https URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should reject URLs with userinfo", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--method",
          "GET",
          "--url",
          "https://user:secret@slack.com/api/conversations.list",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "permission-deny requires --url to be a valid absolute http or https URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should reject raw authority backslashes before URL parser normalization", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--method",
          "GET",
          "--url",
          "https://slack.com\\evil.example/api/conversations.list",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "permission-deny requires --url to be a valid absolute http or https URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should reject invalid HTTP methods", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--method",
          "BAD METHOD",
          "--url",
          "https://slack.com/api/conversations.list",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "permission-deny requires --method to be one of GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    });

    it("should reject URLs outside the selected connector bases", async () => {
      await expect(async () => {
        await permissionDenyCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--method",
          "GET",
          "--url",
          "https://example.com/conversations.list",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "No registered Slack base URL matches the provided URL.",
        ),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should preserve raw encoded paths when matching the selected base", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--url",
        "https://slack.com/api/%7Eraw/conversations.list",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "Slack permission filtered GET /%7Eraw/conversations.list relative to base URL https://slack.com/api",
      );
      expect(logCalls).toContain("No named permission was found");
      expect(mockConsoleError).not.toHaveBeenCalled();
    });

    it("should not echo URL query strings in diagnostic output", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "POST",
        "--url",
        "https://slack.com/api/chat.postMessage?token=secret-token",
      ]);

      const output = [
        ...mockConsoleLog.mock.calls.flat(),
        ...mockConsoleError.mock.calls.flat(),
      ].join("\n");
      expect(output).toContain(
        "Slack permission filtered POST /chat.postMessage relative to base URL https://slack.com/api",
      );
      expect(output).toContain('covered by the "chat:write"');
      expect(output).not.toContain("secret-token");
      expect(output).not.toContain("token=");
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
        "--url",
        "https://slack.com/api/conversations.list",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      // The suggested command should contain the ref, permission, and --enable.
      expect(logCalls).toMatch(
        /zero doctor permission-change slack --permission \S+ --enable --duration 1h/,
      );
      expect(logCalls).not.toContain("--reason");
    });

    it("should suggest unknown endpoint permission-change when no permission matches", async () => {
      await permissionDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "PATCH",
        "--url",
        "https://slack.com/api/totally/unknown/endpoint",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "This request is governed by the unknown endpoint policy.",
      );
      expect(logCalls).toContain(
        "zero doctor permission-change slack --permission __unknown__ --enable --duration 1h",
      );
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
        "--url",
        "https://slack.com/api/conversations.list",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("app.vm0.ai");
      expect(logCalls).not.toContain("[Manage");
      expect(logCalls).not.toContain("[Request");
    });
  });
});
