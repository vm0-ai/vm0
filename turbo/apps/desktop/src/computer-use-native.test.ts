import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createComputerUseNativeBackend } from "./computer-use-native";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(desktopRoot, "dist", "vm0-computer.js");

async function createHelper(
  response: unknown,
): Promise<{ readonly dir: string; readonly helperPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)});
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath };
}

async function createSessionHelper(): Promise<{
  readonly dir: string;
  readonly helperPath: string;
  readonly requestLogPath: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  const requestLogPath = path.join(dir, "requests.ndjson");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const requestLogPath = ${JSON.stringify(requestLogPath)};
let buffer = "";

function responseFor(request) {
  if (
    request.kind === "permissions.state" ||
    request.kind === "permissions.request_accessibility" ||
    request.kind === "permissions.request_screen_recording"
  ) {
    return {
      id: request.id,
      status: "succeeded",
      result: { accessibility: true, screenRecording: true }
    };
  }
  if (request.kind === "apps.list") {
    return {
      id: request.id,
      status: "succeeded",
      result: { apps: ["Safari"] }
    };
  }
  if (request.kind === "app.state") {
    return {
      id: request.id,
      status: "succeeded",
      result: {
        app: request.payload.app,
        snapshotId: request.payload.snapshotId,
        elements: [
          {
            index: 0,
            role: "AXWindow",
            children: [{ index: 1, role: "AXButton", name: "Open" }]
          }
        ],
        elementIdsByIndex: ["w0", "w0.e0"],
        screenshot: "data:image/png;base64,abc123",
        screenshotSource: "window",
        screenshotSourceName: "Example",
        screenshotWidth: 800,
        screenshotHeight: 600,
        screenshotSourceBounds: { x: 0, y: 0, width: 800, height: 600 }
      }
    };
  }
  if (request.kind === "element.click") {
    if (request.payload.x !== undefined && request.payload.y !== undefined) {
      return {
        id: request.id,
        status: "succeeded",
        result: {
          snapshotId: request.payload.snapshotId,
          screenX: 400,
          screenY: 300,
          button: request.payload.button
        }
      };
    }
    return {
      id: request.id,
      status: "succeeded",
      result: {
        snapshotId: request.payload.snapshotId,
        elementIndex: request.payload.elementIndex,
        button: request.payload.button
      }
    };
  }
  return { id: request.id, status: "succeeded", result: {} };
}

function handleLine(line) {
  if (line.trim().length === 0) return;
  const request = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify(request) + "\\n");
  process.stdout.write(JSON.stringify(responseFor(request)) + "\\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath, requestLogPath };
}

describe("computer use native backend", () => {
  beforeAll(async () => {
    await execFileAsync("pnpm", ["build:cli"], { cwd: desktopRoot });
  }, 30_000);

  it("reads permissions from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: { accessibility: true, screenRecording: false },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.getPermissions()).resolves.toEqual({
        accessibility: true,
        screenRecording: false,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("requests accessibility permission through the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: { accessibility: true, screenRecording: true },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.requestAccessibilityPermission()).resolves.toEqual({
        accessibility: true,
        screenRecording: true,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("requests screen recording permission through the native helper", async () => {
    const helper = await createSessionHelper();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
    });

    try {
      await expect(backend.requestScreenRecordingPermission()).resolves.toEqual(
        {
          accessibility: true,
          screenRecording: true,
        },
      );

      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as Record<string, unknown>;
        });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        kind: "permissions.request_screen_recording",
      });
    } finally {
      backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reads coordinate click screen points from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: {
        dispatchMode: "background_mouse_event",
        frontmostRestored: true,
        screenX: 900,
        screenY: 800,
      },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(
        backend.clickPoint({
          app: "Safari",
          snapshotId: "snap_1",
          x: 400,
          y: 300,
          screenshotSource: "window",
          screenshotWidth: 800,
          screenshotHeight: 600,
          sourceBounds: { x: 100, y: 200, width: 1600, height: 1200 },
          windowId: 123,
          windowFrame: { x: 100, y: 200, width: 1600, height: 1200 },
          button: "right",
          clickCount: 2,
        }),
      ).resolves.toEqual({
        dispatchMode: "background_mouse_event",
        frontmostRestored: true,
        screenX: 900,
        screenY: 800,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reads app-open dispatch metadata from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: {
        dispatchMode: "background_app_open",
        dispatchTarget: "target_app",
        inputRisk: "background_app_launch",
        frontmostRestored: false,
      },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.openApp("Things")).resolves.toEqual({
        dispatchMode: "background_app_open",
        dispatchTarget: "target_app",
        inputRisk: "background_app_launch",
        frontmostRestored: false,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reads normalized key names from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: {
        dispatchMode: "background_keyboard_event",
        frontmostRestored: false,
        normalizedKey: "Command+K",
      },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(
        backend.pressKey({ app: "Safari", key: "cmd+k" }),
      ).resolves.toEqual({
        dispatchMode: "background_keyboard_event",
        frontmostRestored: false,
        normalizedKey: "Command+K",
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["app_not_found", "Unable to open Things: Unable to find application"],
    ["app_open_failed", "Unable to open Things"],
    ["element_action_unsupported", "Element does not support a primary click"],
    ["window_unavailable", "Unable to resolve a background window target"],
  ])("preserves %s helper failures", async (code, message) => {
    const helper = await createHelper({
      status: "failed",
      error: { code, message },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.openApp("Things")).rejects.toMatchObject({
        code,
        message,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("uses a session runtime for multiple commands in one helper process", async () => {
    const helper = await createSessionHelper();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
    });

    try {
      await expect(
        backend.getAppState("Safari", "snap_1"),
      ).resolves.toMatchObject({
        app: "Safari",
        snapshotId: "snap_1",
        elementIdsByIndex: ["w0", "w0.e0"],
      });
      await expect(
        backend.clickElement({
          app: "Safari",
          snapshotId: "snap_1",
          elementIndex: 1,
          button: "left",
          clickCount: 1,
        }),
      ).resolves.toEqual({
        snapshotId: "snap_1",
        elementIndex: 1,
        button: "left",
      });
      await expect(
        backend.clickPoint({
          app: "Safari",
          snapshotId: "snap_1",
          x: 200,
          y: 150,
          screenshotSource: "window",
          screenshotWidth: 800,
          screenshotHeight: 600,
          sourceBounds: { x: 0, y: 0, width: 800, height: 600 },
          button: "right",
          clickCount: 1,
        }),
      ).resolves.toEqual({
        snapshotId: "snap_1",
        screenX: 400,
        screenY: 300,
        button: "right",
      });

      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as Record<string, unknown>;
        });
      expect(requests).toHaveLength(3);
      expect(requests[0]).toMatchObject({
        kind: "app.state",
        payload: { app: "Safari", snapshotId: "snap_1" },
      });
      expect(requests[1]).toMatchObject({
        kind: "element.click",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          elementIndex: 1,
          button: "left",
          clickCount: 1,
        },
      });
      expect(requests[2]).toMatchObject({
        kind: "element.click",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          x: 200,
          y: 150,
          screenshotSource: "window",
          button: "right",
        },
      });
    } finally {
      backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("returns post-action app state from the vm0-computer CLI", async () => {
    const helper = await createSessionHelper();
    const commandInput = [
      { kind: "app.state", payload: { app: "Safari" } },
      {
        kind: "element.click",
        payload: {
          app: "Safari",
          elementIndex: 1,
          button: "left",
          clickCount: 1,
        },
      },
    ];

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          cliPath,
          "run",
          JSON.stringify(commandInput),
          "--helper-path",
          helper.helperPath,
        ],
        { cwd: desktopRoot },
      );
      const responses = JSON.parse(stdout) as readonly Record<
        string,
        unknown
      >[];
      expect(responses).toHaveLength(2);
      expect(responses[0]).toMatchObject({
        status: "succeeded",
        result: {
          app: "Safari",
          elementIdsByIndex: ["w0", "w0.e0"],
          screenshot: "data:image/png;base64,abc123",
          appState: expect.stringContaining("<app_state>"),
        },
      });
      expect(responses[1]).toMatchObject({
        status: "succeeded",
        result: {
          app: "Safari",
          screenshot: "data:image/png;base64,abc123",
          appState: expect.stringContaining("<app_state>"),
          action: {
            app: "Safari",
            elementIndex: 1,
            button: "left",
            clickCount: 1,
          },
        },
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("preserves vm0-computer run array output for single-command arrays", async () => {
    const helper = await createSessionHelper();
    const commandInput = [{ kind: "app.state", payload: { app: "Safari" } }];

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          cliPath,
          "run",
          JSON.stringify(commandInput),
          "--helper-path",
          helper.helperPath,
        ],
        { cwd: desktopRoot },
      );
      const responses = JSON.parse(stdout) as readonly Record<
        string,
        unknown
      >[];
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        status: "succeeded",
        result: {
          app: "Safari",
          elementIdsByIndex: ["w0", "w0.e0"],
          screenshot: "data:image/png;base64,abc123",
          appState: expect.stringContaining("<app_state>"),
        },
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("maps Zero CLI command names through vm0-computer", async () => {
    const helper = await createSessionHelper();
    const commandArgs = [
      ["list-apps"],
      ["get-app-state", "--app", "Safari"],
      ["open-app", "--app", "Safari"],
      ["click", "--app", "Safari", "--element", "w0.e0", "--click-count", "2"],
      [
        "scroll",
        "--app",
        "Safari",
        "--element",
        "w0.e0",
        "--direction",
        "down",
        "--pages",
        "2",
      ],
      [
        "set-value",
        "--app",
        "Safari",
        "--element",
        "w0.e0",
        "--value",
        "hello",
      ],
      [
        "perform-action",
        "--app",
        "Safari",
        "--element",
        "w0.e0",
        "--action",
        "AXShowMenu",
      ],
      ["type-text", "--app", "Safari", "--text", "hello"],
      ["press-key", "--app", "Safari", "--key", "Escape"],
    ];

    try {
      for (const args of commandArgs) {
        await execFileAsync(
          process.execPath,
          [cliPath, ...args, "--helper-path", helper.helperPath],
          { cwd: desktopRoot },
        );
      }

      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as {
            readonly kind: string;
            readonly payload?: Record<string, unknown>;
          };
        });
      const publicCommandRequests = requests.filter((request) => {
        return (
          request.kind !== "permissions.state" && request.kind !== "app.state"
        );
      });
      expect(
        publicCommandRequests.map((request) => request.kind),
      ).toStrictEqual([
        "apps.list",
        "app.open",
        "element.click",
        "element.scroll",
        "element.set_value",
        "element.perform_action",
        "keyboard.type_text",
        "keyboard.press_key",
      ]);
      expect(publicCommandRequests[2]?.payload).toMatchObject({
        app: "Safari",
        elementId: "w0.e0",
        button: "left",
        clickCount: 2,
      });
      expect(publicCommandRequests[3]?.payload).toMatchObject({
        elementId: "w0.e0",
        direction: "down",
        pages: 2,
      });
      expect(publicCommandRequests[4]?.payload).toMatchObject({
        value: "hello",
      });
      expect(publicCommandRequests[5]?.payload).toMatchObject({
        action: "AXShowMenu",
      });
      expect(publicCommandRequests[6]?.payload).toMatchObject({
        text: "hello",
      });
      expect(publicCommandRequests[7]?.payload).toMatchObject({
        key: "Escape",
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("does not expose native command kinds as vm0-computer commands", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [cliPath, "app.state", "--app", "Safari", "--helper-path", "/missing"],
        { cwd: desktopRoot },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown vm0-computer command"),
    });
  });
});
