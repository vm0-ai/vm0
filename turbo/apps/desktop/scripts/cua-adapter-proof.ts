import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { createCuaComputerUseDriver } from "../src/computer-use-cua";
import { ComputerUseDriverController } from "../src/computer-use-driver";
import { DesktopQuitConfirmationController } from "../src/desktop-quit-confirmation";
import type { ComputerUseCommandExecutionResult } from "../src/computer-use-accessibility";

const directory = process.argv.at(-1);
if (!directory || !path.isAbsolute(directory))
  throw new Error("Missing dedicated adapter proof directory");
app.commandLine.appendSwitch("disable-gpu");

function result(value: ComputerUseCommandExecutionResult) {
  if (value.status !== "succeeded") throw new Error(value.error.message);
  return value.result;
}

async function prove() {
  assert.equal(process.versions.electron, "42.5.1");
  const driver = new ComputerUseDriverController(
    createCuaComputerUseDriver({
      runtimeRoot: path.join(directory!, "cua"),
      hostBundleId: "ai.okou.desktop",
    }),
    "darwin",
  );
  const commands: string[] = [];
  const execute = async (
    kind: string,
    payload: Record<string, unknown> = {},
  ) => {
    const lease = driver.acquireCommand();
    try {
      const value = await lease.executeCommand(
        { id: `rpc-${commands.length}`, kind, payload },
        await lease.getPermissions(),
      );
      commands.push(kind);
      return result(value);
    } finally {
      lease.release();
    }
  };
  try {
    await driver.withPermissionProvider((provider) =>
      provider.getPermissions(),
    );
    driver.activate();
    const initial = driver.getState();
    const apps = await execute("apps.list");
    assert.ok(Array.isArray(apps.apps));
    const listed: unknown[] = apps.apps;
    assert.ok(
      listed.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "bundleId" in value &&
          value.bundleId === "test.installed",
      ),
    );
    await execute("app.open", { app: "test.editor" });
    let state = await execute("app.state", { app: "test.editor" });
    assert.match(String(state.appState), /Read-only invoice total: 123 元/);
    for (const [kind, payload] of [
      ["element.click", { elementIndex: 1 }],
      ["element.set_value", { elementIndex: 0, value: "你好 🌍\n value " }],
      ["element.perform_action", { elementIndex: 1, action: "AXConfirm" }],
      ["keyboard.type_text", { text: " 中文 👩🏽‍💻\n " }],
      ["keyboard.press_key", { key: "Command+Shift+A" }],
      ["element.scroll", { direction: "down", pages: 2 }],
    ] satisfies [string, Record<string, unknown>][]) {
      state = await execute(kind, {
        app: "test.editor",
        snapshotId: state.snapshotId,
        ...payload,
      });
      assert.ok(
        typeof state.action === "object" &&
          state.action !== null &&
          "effect" in state.action &&
          state.action.effect === "unverifiable",
      );
    }
    let confirmed = false;
    let retirement: Promise<void> | undefined;
    const quit = new DesktopQuitConfirmationController({
      confirmQuit: async () => confirmed,
      quit: () => {
        retirement = driver.retire("app_quit");
      },
    });
    await quit.requestQuit();
    assert.equal(retirement, undefined);
    assert.deepEqual(driver.getState().actual, initial.actual);
    await execute("keyboard.type_text", {
      app: "test.editor",
      snapshotId: state.snapshotId,
      text: "after Cancel",
    });
    confirmed = true;
    await Promise.all([quit.requestQuit(), quit.requestQuit()]);
    assert.ok(retirement);
    await retirement;
    assert.equal(driver.getState().cleanupPending, false);
    assert.equal(driver.getState().ready, false);
    await writeFile(
      path.join(directory!, "adapter.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          electron: process.versions.electron,
          sdkBoundary: "test fixture; no native CUA or user applications",
          productionTransport:
            "bundled helper, Unix socket, retained native guardian",
          commands,
          cancelPreservedGeneration: true,
          confirmedQuitRetired: true,
          stoppedState: driver.getState(),
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await driver.retire("app_quit");
  }
}

void app
  .whenReady()
  .then(prove)
  .then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(error);
      app.exit(1);
    },
  );
