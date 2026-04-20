/**
 * Tests for zero doctor permission-change command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW (org endpoint for role detection)
 * - Real (internal): All CLI code, firewall configs from @vm0/core
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { permissionChangeCommand } from "../permission-change";

/** Minimal org response for MSW handlers */
function orgResponse(role: "admin" | "member") {
  return { id: "org-1", slug: "test-org", name: "Test Org", role };
}

describe("zero doctor permission-change command", () => {
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

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        'You can enable the "channels:read" permission directly',
      );
      expect(logCalls).toContain("[Manage Slack permissions]");
      expect(logCalls).toContain("/agents/agent-abc-123/permissions?");
      expect(logCalls).toContain("ref=slack");
      expect(logCalls).toContain("permission=channels%3Aread");
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

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        'You can disable the "channels:read" permission directly',
      );
      expect(logCalls).toContain("[Manage Slack permissions]");
    });
  });

  describe("member role", () => {
    it("should output request access message for member enable with reason", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("member"));
        }),
      );

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
        "--reason",
        "Need repo access",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Permission changes require admin approval");
      expect(logCalls).toContain("[Request Slack access]");
    });

    it("should output contact admin message for member disable with reason", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("member"));
        }),
      );

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--disable",
        "--reason",
        "No longer needed",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Permission changes require admin approval");
      expect(logCalls).toContain("Contact an org admin to disable");
      expect(logCalls).toContain("[View Slack permissions]");
    });

    it("should only output reason prompt without URL when member omits reason", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("member"));
        }),
      );

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("IMPORTANT: Re-run with `--reason");
      expect(logCalls).not.toContain("[Request Slack access]");
      expect(logCalls).not.toContain("app.vm0.ai");
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
            permissionPolicies: null,
            customSkills: [],
          });
        }),
      );

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        'You can enable the "channels:read" permission directly',
      );
      expect(logCalls).toContain("[Manage Slack permissions]");
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
            permissionPolicies: null,
            customSkills: [],
          });
        }),
      );

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain(
        'You can disable the "channels:read" permission directly',
      );
      expect(logCalls).toContain("[Manage Slack permissions]");
    });
  });

  describe("unknown role (no ZERO_AGENT_ID)", () => {
    it("should output fallback message when ZERO_AGENT_ID is not set", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "");

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('To enable the "channels:read" permission');
      expect(logCalls).toContain("[Manage Slack permissions]");
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

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('To enable the "channels:read" permission');
      expect(logCalls).toContain("[Manage Slack permissions]");
    });
  });

  describe("validation errors", () => {
    it("should exit with error for unknown connector type", async () => {
      await expect(async () => {
        await permissionChangeCommand.parseAsync([
          "node",
          "cli",
          "unknown_service",
          "--permission",
          "foo",
          "--enable",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown connector type: unknown_service"),
      );
    });

    it("should exit with error for invalid permission name", async () => {
      await expect(async () => {
        await permissionChangeCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--permission",
          "nonexistent:perm",
          "--enable",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          'Unknown permission "nonexistent:perm" for slack',
        ),
      );
    });

    it("should exit with error when neither --enable nor --disable is provided", async () => {
      await expect(async () => {
        await permissionChangeCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--permission",
          "channels:read",
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

      await permissionChangeCommand.parseAsync([
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

      await permissionChangeCommand.parseAsync([
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

      await permissionChangeCommand.parseAsync([
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

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
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

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("action=allow");
    });

    it("should include action=deny param for --disable", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-1");

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("action=deny");
    });
  });

  describe("--reason option", () => {
    function setupMemberRole() {
      vi.stubEnv("VM0_TOKEN", "test-token");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("member"));
        }),
      );
    }

    it("should include reason in URL for member role", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      setupMemberRole();

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
        "--reason",
        "Need to read channel list",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("reason=Need+to+read+channel+list");
    });

    it("should truncate reason at 500 characters", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      setupMemberRole();

      const longReason = "b".repeat(600);
      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
        "--reason",
        longReason,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      const match = logCalls.match(/reason=([^&\s)]+)/);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("b".repeat(500));
    });

    it("should keep reason at exactly 500 characters without truncation", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      setupMemberRole();

      const exactReason = "c".repeat(500);
      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
        "--reason",
        exactReason,
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      const match = logCalls.match(/reason=([^&\s)]+)/);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("c".repeat(500));
    });

    it("should not include reason in URL for admin role", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("admin"));
        }),
      );

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
        "--reason",
        "Some reason",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("reason=");
      expect(logCalls).toContain("[Manage Slack permissions]");
    });

    it("should not show IMPORTANT prompt for admin even without reason", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("VM0_TOKEN", "test-token");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      server.use(
        http.get("https://app.vm0.ai/api/zero/org", () => {
          return HttpResponse.json(orgResponse("admin"));
        }),
      );

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("IMPORTANT");
      expect(logCalls).toContain("[Manage Slack permissions]");
    });

    it("should not show IMPORTANT prompt for owner even without reason", async () => {
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
            permissionPolicies: null,
            customSkills: [],
          });
        }),
      );

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--enable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("IMPORTANT");
      expect(logCalls).toContain("[Manage Slack permissions]");
    });

    it("should show reason prompt for member disable without reason", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      setupMemberRole();

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--disable",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("IMPORTANT: Re-run with `--reason");
      expect(logCalls).not.toContain("[View Slack permissions]");
      expect(logCalls).not.toContain("app.vm0.ai");
    });

    it("should include reason in URL for member disable with reason", async () => {
      vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
      vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
      setupMemberRole();

      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "channels:read",
        "--disable",
        "--reason",
        "No longer needed",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("reason=No+longer+needed");
      expect(logCalls).toContain("[View Slack permissions]");
    });
  });
});
