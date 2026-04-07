/**
 * Tests for zero doctor firewall-permissions-change command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW (org endpoint for role detection)
 * - Real (internal): All CLI code, firewall configs from @vm0/core
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { firewallPermissionsChangeCommand } from "../firewall-permissions-change";

/** Minimal org response for MSW handlers */
function orgResponse(role: "admin" | "member") {
  return { id: "org-1", slug: "test-org", name: "Test Org", role };
}

describe("zero doctor firewall-permissions-change command", () => {
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

  describe("admin role", () => {
    it("should output direct enable message for admin", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("admin"));
        }),
      );

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        'You can enable the "contents:read" permission directly',
      );
      expect(logCalls).toContain("[Manage GitHub firewall]");
      expect(logCalls).toContain("/agents/agent-abc-123/permissions?");
      expect(logCalls).toContain("ref=github");
      expect(logCalls).toContain("permission=contents%3Aread");
    });

    it("should output direct disable message for admin", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("admin"));
        }),
      );

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        'You can disable the "contents:read" permission directly',
      );
      expect(logCalls).toContain("[Manage GitHub firewall]");
    });
  });

  describe("member role", () => {
    it("should output request access message for member enable", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("member"));
        }),
      );

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Permission changes require admin approval");
      expect(logCalls).toContain("[Request GitHub access]");
    });

    it("should output contact admin message for member disable", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("member"));
        }),
      );

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Permission changes require admin approval");
      expect(logCalls).toContain("Contact an org admin to disable");
      expect(logCalls).toContain("[View GitHub firewall]");
    });
  });

  describe("owner role", () => {
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

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        'You can enable the "contents:read" permission directly',
      );
      expect(logCalls).toContain("[Manage GitHub firewall]");
    });

    it("should output direct disable message for member who is agent owner", async () => {
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

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        'You can disable the "contents:read" permission directly',
      );
      expect(logCalls).toContain("[Manage GitHub firewall]");
    });
  });

  describe("unknown role (no ZERO_AGENT_ID)", () => {
    it("should output fallback message when ZERO_AGENT_ID is not set", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "");

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('To enable the "contents:read" permission');
      expect(logCalls).toContain("[Manage GitHub firewall]");
      expect(logCalls).toContain("/agents?");
      expect(logCalls).not.toContain("/agents/permissions");
    });
  });

  describe("unknown role (API failure)", () => {
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

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('To enable the "contents:read" permission');
      expect(logCalls).toContain("[Manage GitHub firewall]");
    });
  });

  describe("validation errors", () => {
    it("should exit with error for unknown firewall ref", async () => {
      await expect(async () => {
        await firewallPermissionsChangeCommand.parseAsync([
          "node",
          "cli",
          "unknown_service",
          "--permission",
          "foo",
          "--enable",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Unknown firewall connector type: unknown_service",
        ),
      );
    });

    it("should exit with error for invalid permission name", async () => {
      await expect(async () => {
        await firewallPermissionsChangeCommand.parseAsync([
          "node",
          "cli",
          "github",
          "--permission",
          "nonexistent:perm",
          "--enable",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          'Unknown permission "nonexistent:perm" for github firewall',
        ),
      );
    });

    it("should exit with error when neither --enable nor --disable is provided", async () => {
      await expect(async () => {
        await firewallPermissionsChangeCommand.parseAsync([
          "node",
          "cli",
          "github",
          "--permission",
          "contents:read",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Either --enable or --disable is required"),
      );
    });
  });

  describe("slack chat:write custom guidance", () => {
    it("should output bot alternative guidance for slack chat:write enable", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "chat:write",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("AS THE USER's identity");
      expect(logCalls).toContain("zero slack message send");
      expect(logCalls).toContain("Only request user approval");
    });

    it("should not output bot guidance for slack chat:write disable", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "chat:write",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("AS THE USER's identity");
    });

    it("should not output bot guidance for non-chat:write slack permissions", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("AS THE USER's identity");
    });
  });

  describe("URL construction", () => {
    it("should transform www.vm0.ai to app.vm0.ai", async () => {
      vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        "https://app.vm0.ai/agents/agent-1/permissions?",
      );
    });

    it("should include action=allow param for --enable", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("action=allow");
    });

    it("should include action=deny param for --disable", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await firewallPermissionsChangeCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--permission",
        "contents:read",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("action=deny");
    });
  });
});
