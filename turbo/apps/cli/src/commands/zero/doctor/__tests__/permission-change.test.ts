/**
 * Tests for zero doctor permission-change command.
 *
 * The command always points users at the self-service permission grant page.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { permissionChangeCommand } from "../permission-change";

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

  it("outputs an allow grant link for --enable", async () => {
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
    expect(logCalls).toContain(
      'You can allow the "channels:read" permission for your connector access',
    );
    expect(logCalls).toContain("[Manage Slack permissions]");
    expect(logCalls).toContain("/agents/agent-abc-123/permissions?");
    expect(logCalls).toContain("ref=slack");
    expect(logCalls).toContain("permission=channels%3Aread");
    expect(logCalls).toContain("action=allow");
    expect(logCalls).not.toContain("admin approval");
  });

  it("outputs a deny grant link for --disable", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

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
      'You can deny the "channels:read" permission for your connector access',
    );
    expect(logCalls).toContain("[Manage Slack permissions]");
    expect(logCalls).toContain("action=deny");
    expect(logCalls).not.toContain("admin approval");
  });

  it("does not include --reason text in the grant URL", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

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
      "channels:read",
      "--enable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("/agents?");
    expect(logCalls).not.toContain("/agents/permissions");
  });

  it("transforms www.vm0.ai to app.vm0.ai", async () => {
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

  it("prints sensitive Gmail sending guidance for gmail.send enable", async () => {
    vi.stubEnv("VM0_API_URL", "https://app.vm0.ai");
    vi.stubEnv("ZERO_AGENT_ID", "agent-abc-123");

    await permissionChangeCommand.parseAsync([
      "node",
      "cli",
      "gmail",
      "--permission",
      "gmail.send",
      "--enable",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("send emails directly as the user");
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
        "channels:read",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Either --enable or --disable is required"),
    );
  });
});
