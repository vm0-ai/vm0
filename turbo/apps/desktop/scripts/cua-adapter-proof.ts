import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, watch, writeFile } from "node:fs/promises";
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

async function proveCursorFailure(mode: "rejected" | "mismatch" | "abort") {
  const failurePath = path.join(directory!, "cursor-failure");
  const enteredPath = path.join(directory!, "cursor-entered");
  const launchedPath = path.join(directory!, "app-launched");
  await rm(enteredPath, { force: true });
  await rm(launchedPath, { force: true });
  await writeFile(failurePath, mode);
  let resolveRetired!: () => void;
  const retirementObserved = new Promise<void>((resolve) => {
    resolveRetired = resolve;
  });
  const driver = new ComputerUseDriverController(
    createCuaComputerUseDriver({
      runtimeRoot: path.join(directory!, "cua"),
      hostBundleId: "ai.okou.desktop",
    }),
    "darwin",
    () => {
      const state = driver.getState();
      if (state.actual === null && !state.cleanupPending) resolveRetired();
    },
  );
  const watching = new AbortController();
  try {
    await driver.withPermissionProvider((provider) =>
      provider.getPermissions(),
    );
    driver.activate();
    const lease = driver.acquireCommand();
    try {
      const permissions = await lease.getPermissions();
      const abortWhenEntered = async () => {
        if (mode !== "abort") return;
        const signal = AbortSignal.any([
          watching.signal,
          AbortSignal.timeout(10_000),
        ]);
        for await (const event of watch(directory!, { signal })) {
          if (event.filename === "cursor-entered") {
            assert.ok(lease.abort);
            lease.abort();
            return;
          }
        }
      };
      const cancellation = abortWhenEntered();
      const [response] = await Promise.all([
        lease.executeCommand(
          {
            id: `cursor-${mode}`,
            kind: "app.open",
            payload: { app: "test.editor" },
          },
          permissions,
        ),
        cancellation,
      ]);
      assert.equal(response.status, "failed");
      if (response.status === "failed")
        assert.equal(response.error.code, "accessibility_unavailable");
      assert.equal(existsSync(launchedPath), false);
    } finally {
      lease.release();
    }
    await driver.retire("app_quit");
    await retirementObserved;
    assert.equal(driver.getState().ready, false);
    assert.equal(driver.getState().cleanupPending, false);
    assert.throws(() => driver.acquireCommand(), /not ready/);
    return { mode, commandFailed: true, appUnchanged: true, retired: true };
  } finally {
    watching.abort();
    await driver.retire("app_quit");
    await rm(failurePath, { force: true });
    await rm(enteredPath, { force: true });
    await rm(launchedPath, { force: true });
  }
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
    const cursorFailures = [];
    for (const mode of ["rejected", "mismatch", "abort"] as const)
      cursorFailures.push(await proveCursorFailure(mode));
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
          cursorFailures,
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
