/**
 * Tests for zero connector permission-request command.
 *
 * The command always points users at the self-service permission grant page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { server } from "../../../../mocks/server";
import {
  catalogPermissionDetail,
  stubConnectorCatalogPermissions,
} from "../../__tests__/helpers/connector-catalog";
import { permissionRequestCommand } from "../permission-request";

describe("zero connector permission-request command", () => {
  const SLACK_READ_PERMISSION = "admin.conversations:read";
  const permissionDetails = [
    catalogPermissionDetail({
      connectorSlug: "slack",
      label: "Slack",
      permissions: [
        { name: SLACK_READ_PERMISSION, description: "Read conversations" },
        { name: "chat:write", description: "Send messages" },
      ],
    }),
    catalogPermissionDetail({
      connectorSlug: "gmail",
      label: "Gmail",
      permissions: [
        { name: "messages.send", description: "Send messages" },
        { name: "drafts.send", description: "Send drafts" },
      ],
    }),
    catalogPermissionDetail({
      connectorSlug: "cloudflare",
      label: "Cloudflare",
    }),
  ];

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("ZERO_TOKEN", "test-token");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", "");
    server.use(
      stubConnectorCatalogPermissions(permissionDetails, "https://app.vm0.ai"),
      stubConnectorCatalogPermissions(permissionDetails, "https://www.vm0.ai"),
      stubConnectorCatalogPermissions(permissionDetails, "https://api.vm0.ai"),
      stubConnectorCatalogPermissions(permissionDetails),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("outputs an allow grant link without choosing the user's duration", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      `You can allow the "${SLACK_READ_PERMISSION}" permission for your connector access`,
    );
    expect(logCalls).toContain("[Manage Slack permissions]");
    expect(logCalls).toContain("/agents/agent-abc-123/permissions?");
    expect(logCalls).toContain("connectorSlug=slack");
    expect(logCalls).not.toContain("ref=");
    expect(logCalls).toContain(
      `permission=${encodeURIComponent(SLACK_READ_PERMISSION)}`,
    );
    expect(logCalls).toContain("action=allow");
    expect(logCalls).not.toContain("expiresIn=");
    expect(logCalls).not.toContain("Requested duration:");
    expect(logCalls).not.toContain("admin approval");
  });

  it("uses the agent permission page inside an automated run", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
    vi.stubEnv("ZERO_WORKFLOW_ID", "wf-789");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents/agent-abc-123/permissions?");
    expect(logCalls).not.toContain("/workflows/wf-789/permissions?");
    expect(logCalls).toContain("connectorSlug=slack");
    expect(logCalls).toContain(
      `permission=${encodeURIComponent(SLACK_READ_PERMISSION)}`,
    );
    expect(logCalls).toContain("action=allow");
    expect(logCalls).not.toContain("expiresIn=");
    expect(logCalls).not.toContain("Requested duration:");
  });

  it("includes the current thread and callback prompt in the grant URL", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", "thread-abc-123");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--callback-prompt",
      "Re-check permission & continue",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("connectorSlug=slack");
    expect(logCalls).not.toContain("ref=");
    expect(logCalls).toContain("action=allow");
    expect(logCalls).toContain("threadId=thread-abc-123");
    expect(logCalls).toContain(
      "callbackPrompt=Re-check+permission+%26+continue",
    );
    expect(logCalls).toContain("end the current turn");
    expect(logCalls).not.toContain("expiresIn=");
  });

  it("rejects callback prompts outside the current web chat", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", "");

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
        "--callback-prompt",
        "Continue",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--callback-prompt can only target the current Zero web chat thread and agent",
      ),
    );
  });

  it("rejects callback prompts for a different agent", async () => {
    vi.stubEnv("ZERO_AGENT_ID", "agent-current");
    vi.stubEnv("ZERO_CHAT_THREAD_ID", "thread-abc-123");

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
        "--agent",
        "agent-other",
        "--callback-prompt",
        "Continue",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "--callback-prompt can only target the current Zero web chat thread and agent",
      ),
    );
  });

  it("outputs an allow grant link for unknown endpoints", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "cloudflare",
      "--permission",
      UNKNOWN_PERMISSION_GRANT,
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "You can allow unknown endpoints for your connector access",
    );
    expect(logCalls).toContain("[Manage Cloudflare permissions]");
    expect(logCalls).toContain("connectorSlug=cloudflare");
    expect(logCalls).toContain("permission=__unknown__");
    expect(logCalls).toContain("action=allow");
    expect(logCalls).not.toContain("expiresIn=");
  });

  it("uses the agents landing page when ZERO_AGENT_ID is not set", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents?");
    expect(logCalls).not.toContain("/agents/permissions");
  });

  it("uses --agent when ZERO_AGENT_ID is not set", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--agent",
      "target-agent-123",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents/target-agent-123/permissions?");
    expect(logCalls).toContain("connectorSlug=slack");
    expect(logCalls).toContain("action=allow");
  });

  it("--agent overrides ZERO_AGENT_ID", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "env-agent-123");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--agent",
      "target-agent-123",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents/target-agent-123/permissions?");
    expect(logCalls).not.toContain("/agents/env-agent-123/permissions?");
  });

  it("transforms www.vm0.ai to app.vm0.ai", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://www.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-1");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "https://app.vm0.ai/agents/agent-1/permissions?",
    );
  });

  it("prints sensitive Slack user-token guidance for chat:write enable", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      "chat:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("AS THE USER's identity");
    expect(logCalls).toContain("zero slack message send");
    expect(logCalls).toContain("Only allow this permission below");
  });

  it("prints sensitive Gmail sending guidance for messages.send enable", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "gmail",
      "--permission",
      "messages.send",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("send emails directly as the user");
    expect(logCalls).toContain("drafts.write");
    expect(logCalls).toContain("Only allow this permission below");
  });

  it("validates a server-authored connector absent from the CLI bundle", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    const serverOnlyDetail = catalogPermissionDetail({
      connectorSlug: "server-only",
      label: "Server Only",
      permissions: [
        { name: "records.read", description: "Read server records" },
      ],
    });
    server.use(
      stubConnectorCatalogPermissions(
        [...permissionDetails, serverOnlyDetail],
        "https://app.vm0.ai",
      ),
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "server-only",
      "--permission",
      "records.read",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("[Manage Server Only permissions]");
    expect(logCalls).toContain("connectorSlug=server-only");
    expect(logCalls).toContain("permission=records.read");
  });

  it("exits with an error for an unknown connector slug", async () => {
    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "unknown-service",
        "--permission",
        "foo",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Unknown connector slug: unknown-service"),
    );
  });

  it("exits with authentication guidance when no token is available", async () => {
    vi.stubEnv("ZERO_TOKEN", "");
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
    );
  });

  it("does not treat permission API authorization failures as missing metadata", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    server.use(
      http.get(
        "https://app.vm0.ai/api/zero/connector-catalog/slack/permissions",
        () => {
          return HttpResponse.json(
            { error: { message: "Forbidden", code: "FORBIDDEN" } },
            { status: 403 },
          );
        },
      ),
    );

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("403: Forbidden"),
    );
  });

  it("does not treat permission API network failures as missing metadata", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    server.use(
      http.get(
        "https://app.vm0.ai/api/zero/connector-catalog/slack/permissions",
        () => {
          return HttpResponse.error();
        },
      ),
    );

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
      ]);
    }).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Failed to fetch");
    expect(errorOutput).not.toContain("Unknown connector slug");
  });

  it("rejects permission metadata for a different connector slug", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://app.vm0.ai");
    server.use(
      http.get(
        "https://app.vm0.ai/api/zero/connector-catalog/slack/permissions",
        () => {
          return HttpResponse.json({
            permissions: {
              ...catalogPermissionDetail({
                connectorSlug: "github",
                label: "GitHub",
                permissions: [{ name: SLACK_READ_PERMISSION }],
              }),
            },
          });
        },
      ),
    );

    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Permission metadata connector slug mismatch: expected slack, got github",
      ),
    );
  });

  it("explains selected-host token grants for computer-use permission changes", async () => {
    vi.stubEnv("ZERO_TOKEN", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "computer-use",
      "--permission",
      "computer-use:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Computer Use access is not managed as a connector permission.",
    );
    expect(logCalls).toContain("selected for the chat or thread");
    expect(logCalls).toContain("Existing run tokens cannot be upgraded");
    expect(logCalls).toContain("zero whoami");
    expect(logCalls).not.toContain("[Manage");
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("outputs a delegated authorization link for computer-use enable when authenticated", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "zero-run-token");

    server.use(
      http.post(
        "http://localhost:3000/api/zero/computer-use/authorization-requests",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer zero-run-token",
          );
          return HttpResponse.json({
            authorizationUrl:
              "https://app.vm0.ai/computer-use/authorize/vm0_computer_use_authorization_request_test",
            source: "chat",
            expiresAt: "2026-06-24T13:00:00.000Z",
          });
        },
      ),
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "computer-use",
      "--permission",
      "computer-use:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Computer Use needs a Zero Desktop host selected before a run starts.",
    );
    expect(logCalls).toContain(
      "https://app.vm0.ai/computer-use/authorize/vm0_computer_use_authorization_request_test",
    );
    expect(logCalls).toContain("This link expires at 2026-06-24T13:00:00.000Z");
    expect(logCalls).not.toContain(
      "Computer Use authorization link unavailable",
    );
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("recognizes computer-use:write even when the connector slug is wrong", async () => {
    vi.stubEnv("ZERO_TOKEN", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "agent",
      "--permission",
      "computer-use:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Computer Use access is not managed as a connector permission.",
    );
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("explains thread access for cloud browser permission changes", async () => {
    vi.stubEnv("ZERO_TOKEN", "");

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "browser",
      "--permission",
      "browser:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Cloud browser access is controlled by the current chat thread",
    );
    expect(logCalls).toContain("under Your computer in the chat composer");
    expect(logCalls).toContain("Existing run tokens cannot be upgraded");
    expect(logCalls).not.toContain("[Manage");
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("outputs a delegated authorization link for cloud browser enable", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "zero-run-token");

    server.use(
      http.post(
        "http://localhost:3000/api/zero/browser/authorization-requests",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer zero-run-token",
          );
          return HttpResponse.json({
            authorizationUrl:
              "https://app.vm0.ai/browser/authorize/vm0_browser_authorization_request_test",
            expiresAt: "2026-07-27T13:00:00.000Z",
          });
        },
      ),
    );

    await permissionRequestCommand.parseAsync([
      "node",
      "cli",
      "browser",
      "--permission",
      "browser:write",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Cloud browser needs to be enabled for this chat thread",
    );
    expect(logCalls).toContain(
      "https://app.vm0.ai/browser/authorize/vm0_browser_authorization_request_test",
    );
    expect(logCalls).toContain("This link expires at 2026-07-27T13:00:00.000Z");
    expect(logCalls).not.toContain(
      "Cloud browser authorization link unavailable",
    );
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("exits with an error for an invalid permission name", async () => {
    await expect(async () => {
      await permissionRequestCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        "nonexistent:perm",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unknown permission "nonexistent:perm" for slack',
      ),
    );
  });

  it.each(["--enable", "--disable", "--duration", "--auto-continue"])(
    "does not expose the legacy %s flag",
    async (flag) => {
      await expect(
        permissionRequestCommand.parseAsync([
          "node",
          "cli",
          "slack",
          "--permission",
          SLACK_READ_PERMISSION,
          flag,
        ]),
      ).rejects.toThrow("process.exit called");
    },
  );
});
