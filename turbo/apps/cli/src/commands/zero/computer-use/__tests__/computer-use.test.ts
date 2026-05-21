/**
 * Tests for computer-use command registration and visibility.
 *
 * Entry point: registerZeroCommands()
 * Mock (external): none
 * Real (internal): Command registration, capability checking
 */

import { readFile, rm } from "node:fs/promises";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command, Help } from "commander";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import {
  formatComputerUseResultForConsole,
  zeroComputerUseCommand,
} from "../index";
import { registerZeroCommands } from "../../../../zero";

const TEST_SCREENSHOT_PATH =
  "/tmp/vm0/computer-use/Slack-Test-App-desktop_test_snapshot.png";

function buildZeroToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "test-signature";
  return `vm0_sandbox_${header}.${body}.${signature}`;
}

function visibleCommandNames(prog: Command): string[] {
  return new Help()
    .visibleCommands(prog)
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return name !== "help";
    });
}

function hiddenCommandNames(prog: Command): string[] {
  const visible = new Set(visibleCommandNames(prog));
  return prog.commands
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return !visible.has(name);
    });
}

describe("computer-use command visibility", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    mockConsoleLog.mockClear();
    vi.stubEnv("ZERO_TOKEN", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(TEST_SCREENSHOT_PATH, { force: true });
  });

  it("should be visible when no ZERO_TOKEN is set", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const cmd = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    expect(cmd).toBeDefined();
  });

  it("should be visible when ZERO_TOKEN includes computer-use:write", () => {
    const token = buildZeroToken({
      userId: "u1",
      runId: "r1",
      orgId: "o1",
      scope: "zero",
      capabilities: ["computer-use:write"],
      iat: 1000,
      exp: 2000,
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = new Command();
    registerZeroCommands(prog);

    expect(visibleCommandNames(prog)).toContain("computer-use");
  });

  it("should be hidden when ZERO_TOKEN lacks computer-use:write", () => {
    const token = buildZeroToken({
      userId: "u1",
      runId: "r1",
      orgId: "o1",
      scope: "zero",
      capabilities: ["agent:read"],
      iat: 1000,
      exp: 2000,
    });
    vi.stubEnv("ZERO_TOKEN", token);

    const prog = new Command();
    registerZeroCommands(prog);

    expect(hiddenCommandNames(prog)).toContain("computer-use");
  });

  it("should have Desktop-backed agent command subcommands", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const computerUse = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    expect(computerUse).toBeDefined();

    const subNames = computerUse!.commands.map((c) => {
      return c.name();
    });
    expect(subNames).toContain("list-apps");
    expect(subNames).toContain("get-app-state");
    expect(subNames).toContain("click");
    expect(subNames).toContain("scroll");
    expect(subNames).toContain("set-value");
    expect(subNames).toContain("type-text");
    expect(subNames).toContain("press-key");
    expect(subNames).toContain("perform-action");
    expect(subNames).toContain("open-app");
    expect(subNames).toContain("hosts");
    expect(subNames).toContain("revoke-host");
    expect(subNames).toContain("audit");
  });

  it("should write screenshot data URLs to a local file in command result console output", async () => {
    const screenshotBytes = Buffer.from("test-png-data");
    const screenshotBase64 = screenshotBytes.toString("base64");
    const text = await formatComputerUseResultForConsole({
      app: "Slack/Test App",
      snapshotId: "desktop_test_snapshot",
      text: "snapshot_id=snap_1\nw0 AXWindow",
      screenshot: `data:image/png;base64,${screenshotBase64}`,
      screenshotSource: "window",
    });

    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.screenshot).toBe(TEST_SCREENSHOT_PATH);
    expect(text).toContain("snapshot_id=snap_1");
    expect(text).toContain("screenshotSource");
    expect(text).not.toContain(screenshotBase64);
    await expect(readFile(TEST_SCREENSHOT_PATH)).resolves.toEqual(
      screenshotBytes,
    );
  });

  it("should print a screenshot file path for get-app-state", async () => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    const screenshotBytes = Buffer.from("test-png-data");
    const screenshotBase64 = screenshotBytes.toString("base64");
    server.use(
      http.post(
        "http://localhost:3000/api/zero/computer-use/commands",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body.kind).toBe("app.state");
          expect(body.app).toBe("Slack/Test App");
          return HttpResponse.json({
            commandId: "cmd_1",
            status: "queued",
          });
        },
      ),
      http.get(
        "http://localhost:3000/api/zero/computer-use/commands/cmd_1",
        () => {
          return HttpResponse.json({
            id: "cmd_1",
            kind: "app.state",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: { app: "Slack/Test App" },
            result: {
              app: "Slack/Test App",
              snapshotId: "desktop_test_snapshot",
              text: "snapshot_id=desktop_test_snapshot\nw0 AXWindow",
              screenshot: `data:image/png;base64,${screenshotBase64}`,
              screenshotMimeType: "image/png",
              screenshotWidth: 1363,
              screenshotHeight: 1200,
            },
            timeoutMs: 10_000,
            createdAt: "2026-05-21T10:00:00.000Z",
            claimedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:02.000Z",
          });
        },
      ),
    );

    await zeroComputerUseCommand.parseAsync([
      "node",
      "cli",
      "get-app-state",
      "--app",
      "Slack/Test App",
      "--timeout",
      "10",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.screenshot).toBe(TEST_SCREENSHOT_PATH);
    expect(parsed.text).toBe("snapshot_id=desktop_test_snapshot\nw0 AXWindow");
    expect(parsed.screenshotWidth).toBe(1363);
    expect(parsed.screenshotHeight).toBe(1200);
    expect(output).not.toContain(screenshotBase64);
    await expect(readFile(TEST_SCREENSHOT_PATH)).resolves.toEqual(
      screenshotBytes,
    );
  });

  it("should send click snapshot coordinates and mouse options", async () => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    server.use(
      http.post(
        "http://localhost:3000/api/zero/computer-use/write-commands",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            kind: "element.click",
            app: "Slack",
            snapshotId: "snap_1",
            x: 680,
            y: 600,
            button: "right",
            clickCount: 2,
            timeoutMs: 10_000,
          });
          return HttpResponse.json({
            commandId: "cmd_click",
            status: "queued",
          });
        },
      ),
      http.get(
        "http://localhost:3000/api/zero/computer-use/commands/cmd_click",
        () => {
          return HttpResponse.json({
            id: "cmd_click",
            kind: "element.click",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: {
              app: "Slack",
              snapshotId: "snap_1",
              x: 680,
              y: 600,
              button: "right",
              clickCount: 2,
            },
            result: { text: "clicked" },
            timeoutMs: 10_000,
            createdAt: "2026-05-21T10:00:00.000Z",
            claimedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:02.000Z",
          });
        },
      ),
    );

    await zeroComputerUseCommand.parseAsync([
      "node",
      "cli",
      "click",
      "--app",
      "Slack",
      "--snapshot-id",
      "snap_1",
      "--x",
      "680",
      "--y",
      "600",
      "--button",
      "right",
      "--click-count",
      "2",
      "--timeout",
      "10",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('"text": "clicked"');
  });

  it("should include dispatch and input risk metadata in audit output", async () => {
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    server.use(
      http.get(
        "http://localhost:3000/api/zero/computer-use/audit-events",
        () => {
          return HttpResponse.json({
            auditEvents: [
              {
                id: "audit_1",
                commandId: "cmd_1",
                runId: null,
                hostId: "host_1",
                kind: "keyboard.press_key",
                app: "Safari",
                event: "completed",
                approvalOutcome: null,
                redactedResult: {
                  dispatchMode: "targeted_keyboard_event",
                  inputRisk: "targeted_app_shortcut",
                },
                error: null,
                createdAt: "2026-05-21T10:00:00.000Z",
              },
            ],
          });
        },
      ),
    );

    await zeroComputerUseCommand.parseAsync([
      "node",
      "cli",
      "audit",
      "--limit",
      "1",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("dispatch=targeted_keyboard_event");
    expect(output).toContain("risk=targeted_app_shortcut");
  });
});
