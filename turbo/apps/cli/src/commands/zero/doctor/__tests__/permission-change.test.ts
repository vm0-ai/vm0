/**
 * Tests for zero doctor permission-change command.
 *
 * The command always points users at the self-service permission grant page.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { server } from "../../../../mocks/server";
import { permissionChangeCommand } from "../permission-change";

describe("zero doctor permission-change command", () => {
  const SLACK_READ_PERMISSION = "admin.conversations:read";

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

  it("outputs an allow grant link for --enable", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--enable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      `You can allow the "${SLACK_READ_PERMISSION}" permission for your connector access`,
    );
    expect(logCalls).toContain("[Manage Slack permissions]");
    expect(logCalls).toContain("/agents/agent-abc-123/permissions?");
    expect(logCalls).toContain("ref=slack");
    expect(logCalls).toContain(
      `permission=${encodeURIComponent(SLACK_READ_PERMISSION)}`,
    );
    expect(logCalls).toContain("action=allow");
    expect(logCalls).toContain("expiresIn=1h");
    expect(logCalls).toContain("Requested duration: 1h");
    expect(logCalls).not.toContain("admin approval");
  });

  it("deep-links to the workflow authorization tab inside an unattended trigger run", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");
    vi.stubEnv("ZERO_WORKFLOW_ID", "wf-789");
    vi.stubEnv("ZERO_WORKFLOW_TRIGGER_ID", "trig-456");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--enable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents/agent-abc-123/workflows/wf-789?");
    expect(logCalls).toContain("tab=authorization");
    expect(logCalls).toContain("ref=slack");
    expect(logCalls).toContain(
      `permission=${encodeURIComponent(SLACK_READ_PERMISSION)}`,
    );
    expect(logCalls).toContain("action=allow");
    expect(logCalls).toContain("expiresIn=1h");
    expect(logCalls).toContain("Requested duration: 1h");
    // Trigger-fired runs use workflow-user grants, so the agent permission page
    // and legacy trigger permission editor are not used.
    expect(logCalls).not.toContain("/agents/agent-abc-123/permissions?");
    expect(logCalls).not.toContain("/triggers/trig-456/permissions?");
  });

  it("outputs an allow grant link with an explicit duration", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--enable",
      "--duration",
      "24h",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("action=allow");
    expect(logCalls).toContain("expiresIn=24h");
    expect(logCalls).toContain("Requested duration: 24h");
  });

  it("outputs a deny grant link for --disable", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--disable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      `You can deny the "${SLACK_READ_PERMISSION}" permission for your connector access`,
    );
    expect(logCalls).toContain("[Manage Slack permissions]");
    expect(logCalls).toContain("action=deny");
    expect(logCalls).not.toContain("expiresIn=");
    expect(logCalls).not.toContain("Requested duration");
    expect(logCalls).not.toContain("admin approval");
  });

  it("outputs a deny grant link for unknown endpoints", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "cloudflare",
      "--permission",
      UNKNOWN_PERMISSION_GRANT,
      "--disable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "You can deny unknown endpoints for your connector access",
    );
    expect(logCalls).toContain("[Manage Cloudflare permissions]");
    expect(logCalls).toContain("ref=cloudflare");
    expect(logCalls).toContain("permission=__unknown__");
    expect(logCalls).toContain("action=deny");
    expect(logCalls).not.toContain("expiresIn=");
  });

  it("does not include --reason text in the grant URL", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--enable",
      "--reason",
      "Need to read channel list",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("[Manage Slack permissions]");
    expect(logCalls).not.toContain("reason=");
    expect(logCalls).not.toContain("Re-run with `--reason");
  });

  it("uses the agents landing page when ZERO_AGENT_ID is not set", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--enable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents?");
    expect(logCalls).not.toContain("/agents/permissions");
  });

  it("uses --agent when ZERO_AGENT_ID is not set", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--enable",
      "--agent",
      "target-agent-123",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents/target-agent-123/permissions?");
    expect(logCalls).toContain("ref=slack");
    expect(logCalls).toContain("action=allow");
  });

  it("--agent overrides ZERO_AGENT_ID", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "env-agent-123");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--enable",
      "--agent",
      "target-agent-123",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents/target-agent-123/permissions?");
    expect(logCalls).not.toContain("/agents/env-agent-123/permissions?");
  });

  it("transforms www.vm0.ai to app.vm0.ai", async () => {
    vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-1");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "slack",
      "--permission",
      SLACK_READ_PERMISSION,
      "--enable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "https://app.vm0.ai/agents/agent-1/permissions?",
    );
  });

  it("prints sensitive Slack user-token guidance for chat:write enable", async () => {
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
    expect(logCalls).toContain("Only allow this permission below");
  });

  it("prints sensitive Gmail sending guidance for messages.send enable", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "gmail",
      "--permission",
      "messages.send",
      "--enable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("send emails directly as the user");
    expect(logCalls).toContain("drafts.write");
    expect(logCalls).toContain("Only allow this permission below");
  });

  it("exits with an error for an unknown connector type", async () => {
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

  it("explains selected-host token grants for computer-use permission changes", async () => {
    vi.stubEnv("ZERO_TOKEN", "");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "computer-use",
      "--permission",
      "computer-use:write",
      "--enable",
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
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
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

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "computer-use",
      "--permission",
      "computer-use:write",
      "--enable",
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

  it("recognizes computer-use:write even when the connector ref is wrong", async () => {
    vi.stubEnv("ZERO_TOKEN", "");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "agent",
      "--permission",
      "computer-use:write",
      "--enable",
      "--duration",
      "1h",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain(
      "Computer Use access is not managed as a connector permission.",
    );
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it("exits with an error for an invalid permission name", async () => {
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

  it("exits with an error when neither --enable nor --disable is provided", async () => {
    await expect(async () => {
      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Either --enable or --disable is required"),
    );
  });

  it("exits with an error when --duration is used with --disable", async () => {
    await expect(async () => {
      await permissionChangeCommand.parseAsync([
        "node",
        "cli",
        "slack",
        "--permission",
        SLACK_READ_PERMISSION,
        "--disable",
        "--duration",
        "1h",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--duration is only supported with --enable"),
    );
  });
});
