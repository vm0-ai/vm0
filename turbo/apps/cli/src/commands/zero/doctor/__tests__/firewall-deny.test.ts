/**
 * Tests for zero doctor firewall-deny command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW (org endpoint for role detection)
 * - Real (internal): All CLI code, firewall configs from @vm0/core
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { firewallDenyCommand } from "../firewall-deny";

/** Minimal org response for MSW handlers */
function orgResponse(role: "admin" | "member") {
  return { id: "org-1", slug: "test-org", name: "Test Org", role };
}

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
        /\[Manage GitHub firewall\]\(https:\/\/app\.vm0\.ai\/agents\/agent-abc-123\/permissions\?/,
      );
      expect(logCalls).toContain("ref=github");
      expect(logCalls).toContain("permission=");
    });
  });

  describe("known ref with no matching permission", () => {
    it("should output no-permission message for unmatched path", async () => {
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

  describe("slack chat:write custom guidance", () => {
    it("should output bot alternative guidance for slack chat:write", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

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
      expect(logCalls).toContain("AS THE USER's identity");
      expect(logCalls).toContain("zero slack message send");
      expect(logCalls).toContain("Only request user approval");
      // Should still show the approval URL via outputPermissionChangeMessage
      expect(logCalls).toContain("[Manage Slack firewall]");
    });

    it("should not output bot guidance for non-chat:write slack permissions", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

      await firewallDenyCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--method",
        "GET",
        "--path",
        "/conversations.list",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Slack firewall blocked");
      expect(logCalls).not.toContain("AS THE USER's identity");
      expect(logCalls).not.toContain("zero slack message send");
    });

    it("should not output bot guidance for non-slack connectors", async () => {
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
      expect(logCalls).toContain("GitHub firewall blocked");
      expect(logCalls).not.toContain("AS THE USER's identity");
      expect(logCalls).not.toContain("zero slack message send");
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
      expect(logCalls).toContain(
        "https://app.vm0.ai/agents/agent-1/permissions?",
      );
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
        "https://tunnel-yuma-vm0-app.vm7.ai/agents/agent-1/permissions?",
      );
    });
  });

  describe("role-aware messaging (delegates to outputPermissionChangeMessage)", () => {
    it("should output direct enable message for admin", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("admin"));
        }),
      );

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
      expect(logCalls).toContain("You can enable the");
      expect(logCalls).toContain("[Manage GitHub firewall]");
    });

    it("should output request access message for member", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("member"));
        }),
      );

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
        "Permission changes require admin approval. Request access at: [Request GitHub access]",
      );
    });

    it("should output direct enable message for member who is agent owner", async () => {
      const payload = Buffer.from(
        JSON.stringify({
          userId: "owner-user-1",
          orgId: "org-1",
          scope: "cli",
          tokenId: "t1",
        }),
      ).toString("base64url");
      const fakeToken = `vm0_pat_header.${payload}.sig`;

      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", fakeToken);
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("member"));
        }),
        http.get("https://app.vm0.ai/api/zero/agents/:id", () => {
          return HttpResponse.json({
            agentId: "agent-abc-123",
            ownerId: "owner-user-1",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            firewallPolicies: null,
            customSkills: [],
          });
        }),
      );

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
      expect(logCalls).toContain("You can enable the");
      expect(logCalls).toContain("[Manage GitHub firewall]");
    });

    it("should output fallback message when org API fails", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(
            { error: { message: "Internal error", code: "INTERNAL" } },
            { status: 500 },
          );
        }),
      );

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
      expect(logCalls).toContain("To enable the");
      expect(logCalls).toContain("[Manage GitHub firewall]");
    });
  });

  describe("ZERO_AGENT_ID presence/absence", () => {
    it("should use /agents/:id/permissions when ZERO_AGENT_ID is set", async () => {
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
      expect(logCalls).toContain("/agents/my-agent-id/permissions?");
    });

    it("should use /agents when ZERO_AGENT_ID is not set", async () => {
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
      expect(logCalls).toContain("/agents?");
      expect(logCalls).not.toContain("/agents/permissions");
    });
  });
});
