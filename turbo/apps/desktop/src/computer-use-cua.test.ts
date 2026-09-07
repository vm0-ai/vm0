import { afterEach, describe, expect, it } from "vitest";
import { createCuaComputerUseDriver } from "./computer-use-cua";
import { ComputerUseDriverController } from "./computer-use-driver";
import { cuaBoundary, deferred } from "./test/cua-boundary";
import type { ComputerUseCommandExecutionResult } from "./computer-use-accessibility";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function desktop() {
  const external = cuaBoundary();
  const definition = createCuaComputerUseDriver({
    runtimeRoot: "/packaged/cua",
    hostBundleId: "ai.okou.desktop",
    loadSdk: async () => external.sdk,
  });
  const driver = new ComputerUseDriverController(definition, "darwin");
  await driver.withPermissionProvider((provider) => provider.getPermissions());
  driver.activate();
  cleanups.push(() => driver.retire());
  const execute = async (
    kind: string,
    payload: Record<string, unknown> = {},
  ) => {
    const session = driver.acquireCommand();
    try {
      return await session.executeCommand(
        { id: "command", kind, payload },
        await session.getPermissions(),
      );
    } finally {
      session.release();
    }
  };
  return {
    external,
    driver,
    definition,
    execute,
    observe: () => execute("app.state", { app: "test.editor" }),
  };
}
function result(
  value: ComputerUseCommandExecutionResult,
): Record<string, unknown> {
  expect(value.status).toBe("succeeded");
  if (value.status !== "succeeded") throw new Error(value.error.message);
  return value.result;
}

describe("host-owned CUA adapter and shared executor", () => {
  it("executes all nine command kinds with one session and exact public tool mapping", async () => {
    const d = await desktop();
    const apps = result(await d.execute("apps.list"));
    expect(apps).toMatchObject({
      discoveryNote: expect.stringContaining("~/Applications"),
      apps: expect.arrayContaining([
        expect.objectContaining({
          bundleId: "test.installed",
          pid: 0,
          running: false,
        }),
      ]),
    });
    let state = result(await d.execute("app.open", { app: "test.editor" }));
    expect(state.action).toMatchObject({ driver: "cua", launch: { pid: 123 } });
    state = result(await d.observe());
    expect(state.appState).toContain("Read-only invoice total: 123 元");
    expect(state.appState).toContain("[1] Save");
    for (const [kind, payload] of [
      ["element.click", { elementIndex: 1 }],
      ["element.set_value", { elementIndex: 0, value: "你好 🌍\n value " }],
      ["element.perform_action", { elementIndex: 1, action: "AXConfirm" }],
      ["keyboard.type_text", { text: " 中文 👩🏽‍💻\n " }],
      ["keyboard.press_key", { key: "Command+Shift+A" }],
      ["element.scroll", { direction: "down", pages: 2 }],
    ] satisfies [string, Record<string, unknown>][]) {
      state = result(
        await d.execute(kind, {
          app: "test.editor",
          snapshotId: state.snapshotId,
          ...payload,
        }),
      );
      expect(state.action).toMatchObject({
        effect: "unverifiable",
        driver: "cua",
        summary: expect.stringContaining("unverifiable"),
      });
    }
    expect(d.external.sessions).toBe(1);
    expect(
      d.external.calls.find((call) => call.name === "type_text")?.args.text,
    ).toBe(" 中文 👩🏽‍💻\n ");
    expect(
      d.external.calls.find((call) => call.name === "press_key")?.args,
    ).toMatchObject({
      pid: 123,
      window_id: 42,
      key: "a",
      modifiers: ["cmd", "shift"],
    });
    expect(
      d.external.calls.find((call) => call.name === "scroll")?.args,
    ).toMatchObject({ amount: 2, by: "page" });
  });

  it.each(["never", "on-window-unavailable", "always"])(
    "honors %s without retrying an uncertain action",
    async (foregroundRecovery) => {
      const d = await desktop();
      const state = result(await d.observe());
      const done = result(
        await d.execute("element.click", {
          app: "test.editor",
          snapshotId: state.snapshotId,
          elementIndex: 1,
          foregroundRecovery,
        }),
      );
      expect(done.action).toMatchObject({ effect: "unverifiable" });
      const clicks = d.external.calls.filter((call) => call.name === "click");
      expect(clicks).toHaveLength(1);
      expect(clicks[0]?.args.delivery_mode).toBe(
        foregroundRecovery === "always" ? "foreground" : "background",
      );
    },
  );

  it.each([
    ["element.perform_action", { elementIndex: 1, action: "AXRaise" }],
    ["element.perform_action", { elementIndex: 1, action: "toString" }],
    [
      "element.set_value",
      {
        app: "com.google.Chrome",
        elementIndex: 0,
        value: "https://example.test",
      },
    ],
    ["element.click", { elementIndex: 1, clickCount: 2 }],
    ["element.click", { x: 12, y: 12, button: "invalid" }],
    ["element.scroll", { direction: "down", pages: 0.5 }],
    ["element.scroll", { direction: "down", pages: 1, elementIndex: 1 }],
    ["keyboard.press_key", { key: "cmd+not-a-key" }],
    ["keyboard.type_text", { text: "text</invoke>" }],
  ])(
    "refuses unsupported %s before actuator dispatch",
    async (kind, payload) => {
      const d = await desktop();
      const state = result(await d.observe());
      const before = d.external.calls.length;
      expect(
        await d.execute(kind, {
          app: "test.editor",
          snapshotId: state.snapshotId,
          ...payload,
        }),
      ).toMatchObject({
        status: "failed",
        error: { code: "unsupported_command" },
      });
      expect(
        d.external.calls
          .slice(before)
          .every((call) =>
            ["check_permissions", "list_apps", "list_windows"].includes(
              call.name,
            ),
          ),
      ).toBe(true);
    },
  );

  it("invalidates raw IDs and numeric indexes when the same window is re-observed", async () => {
    const d = await desktop();
    const old = result(await d.observe());
    const fresh = result(await d.observe());
    const oldIds = old.elementIdsByIndex as string[];
    for (const target of [
      { elementId: oldIds[0] },
      { snapshotId: old.snapshotId, elementIndex: 0 },
      { elementIndex: 0 },
    ]) {
      expect(
        await d.execute("element.click", { app: "test.editor", ...target }),
      ).toMatchObject({ status: "failed" });
    }
    result(
      await d.execute("element.click", {
        app: "test.editor",
        snapshotId: fresh.snapshotId,
        elementIndex: 0,
      }),
    );
    expect(
      d.external.calls.find((call) => call.name === "click")?.args
        .element_token,
    ).toBe("opaque-field-2");
  });

  it("cannot resurrect raw IDs after switching away and back to CUA", async () => {
    const d = await desktop();
    const old = result(await d.observe());
    await d.driver.retire();
    const fresh = cuaBoundary();
    d.driver.select(
      createCuaComputerUseDriver({
        runtimeRoot: "/packaged/cua",
        hostBundleId: "ai.okou.desktop",
        loadSdk: async () => fresh.sdk,
      }),
    );
    await d.driver.withPermissionProvider((provider) =>
      provider.getPermissions(),
    );
    d.driver.activate();
    result(await d.observe());
    const ids = old.elementIdsByIndex as string[];
    expect(
      await d.execute("element.click", {
        app: "test.editor",
        elementId: ids[0],
      }),
    ).toMatchObject({ status: "failed" });
    expect(fresh.calls.some((call) => call.name === "click")).toBe(false);
  });

  it.each([1, 2])(
    "retains %sx geometry through upstream resizing and derives request coordinates once",
    async (scale) => {
      const d = await desktop();
      d.external.scale = scale;
      d.external.resize = 0.5;
      let state = result(await d.observe());
      for (const [button, clickCount] of [
        ["left", 2],
        ["right", 1],
        ["middle", 1],
      ] as const) {
        state = result(
          await d.execute("element.click", {
            app: "test.editor",
            snapshotId: state.snapshotId,
            x: 100,
            y: 50,
            button,
            clickCount,
          }),
        );
        expect(state.action).toMatchObject({
          screenX: 10 + 200 / scale,
          screenY: 20 + 100 / scale,
          coordinateSource: "retained_request_frame",
        });
      }
      expect(
        d.external.calls.find((call) => call.name === "click")?.args,
      ).toMatchObject({ x: 100, y: 50, scope: "window" });
    },
  );

  it.each(["pid", "window", "moved", "scaled", "display-scale"])(
    "refuses changed %s ownership/frame",
    async (change) => {
      const d = await desktop();
      const state = result(await d.observe());
      if (change === "pid") d.external.pid = 124;
      if (change === "window") d.external.windowId = 43;
      if (change === "moved")
        d.external.bounds = { x: 30, y: 20, width: 800, height: 600 };
      if (change === "scaled")
        d.external.bounds = { x: 10, y: 20, width: 900, height: 600 };
      if (change === "display-scale") d.external.scale = 1;
      expect(
        await d.execute("element.click", {
          app: "test.editor",
          snapshotId: state.snapshotId,
          x: 100,
          y: 50,
        }),
      ).toMatchObject({ status: "failed" });
      expect(d.external.calls.some((call) => call.name === "click")).toBe(
        false,
      );
    },
  );

  it("refuses coordinates when a fresh screenshot frame is invalid", async () => {
    const d = await desktop();
    const state = result(await d.observe());
    d.external.observation = { screenshot_frame_valid: false };
    expect(
      await d.execute("element.click", {
        app: "test.editor",
        snapshotId: state.snapshotId,
        x: 100,
        y: 50,
      }),
    ).toMatchObject({
      status: "failed",
      error: { code: "window_unavailable" },
    });
    expect(d.external.calls.some((call) => call.name === "click")).toBe(false);
    expect(
      await d.execute("element.click", {
        app: "test.editor",
        snapshotId: state.snapshotId,
        elementIndex: 0,
      }),
    ).toMatchObject({ status: "failed" });
  });

  it("preserves read-only text and incomplete coverage when AX window scope is unresolved", async () => {
    const d = await desktop();
    d.external.observation = {
      elements: [],
      snapshot_id: undefined,
      tree_markdown: "Read-only invoice total: 123 元",
      degraded_reason: "ax_window_unresolved",
    };
    const state = result(await d.observe());
    expect(state.appState).toContain("Read-only invoice total: 123 元");
    expect(state.appState).toContain("Element coverage is incomplete");
    expect(state.elementIdsByIndex).toEqual([]);
    expect(JSON.stringify(state)).toContain("ax_window_unresolved");
    expect(
      await d.execute("element.click", {
        app: "test.editor",
        snapshotId: state.snapshotId,
        elementIndex: 0,
      }),
    ).toMatchObject({ status: "failed" });
    expect(d.external.calls.some((call) => call.name === "click")).toBe(false);
  });

  it.each([
    {
      effect: "confirmed",
      route: "accessibility",
      evidence: [{ kind: "value_readback" }],
    },
    {
      effect: "partial",
      route: "synthetic_events",
      delivery: { mode: "background", delivered_count: 2 },
    },
    { effect: "suspected_noop", route: "accessibility" },
    { effect: "refused", route: "accessibility" },
  ])("retains $effect action facts through post-state", async (facts) => {
    const d = await desktop();
    d.external.effect = facts;
    const state = result(await d.observe());
    const completed = await d.execute("element.click", {
      app: "test.editor",
      snapshotId: state.snapshotId,
      elementIndex: 1,
    });
    if (facts.effect === "refused")
      expect(completed).toMatchObject({
        status: "failed",
        error: {
          code: "element_action_unsupported",
          message: expect.stringContaining('"effect":"refused"'),
        },
      });
    else expect(result(completed).action).toMatchObject(facts);
  });

  it("preserves partial delivery when post-action capture fails", async () => {
    const d = await desktop();
    const state = result(await d.observe());
    d.external.effect = {
      effect: "partial",
      route: "synthetic_events",
      delivery: { mode: "background", delivered_count: 1 },
    };
    d.external.intercept = async (name) => {
      if (name === "get_window_state") throw new Error("capture failed");
    };
    const completed = result(
      await d.execute("element.click", {
        app: "test.editor",
        snapshotId: state.snapshotId,
        elementIndex: 1,
      }),
    );
    expect(completed).toMatchObject({
      action: { effect: "partial" },
      observationError: { code: "accessibility_unavailable" },
    });
    expect(d.driver.getCapabilities()).toEqual([]);
  });

  it.each(["check_permissions", "session", "click", "get_window_state", "end"])(
    "stops independently of a hung %s and retains cleanup ownership until its late callback settles",
    async (phase) => {
      const d = await desktop();
      let state: Record<string, unknown> = {};
      if (!["session", "check_permissions"].includes(phase))
        state = result(await d.observe());
      const entered = deferred<void>();
      const release = deferred<void>();
      d.external.intercept = async (name) => {
        if (name === phase) {
          entered.resolve();
          await release.promise;
        }
      };
      const operation =
        phase === "end"
          ? d.driver.retire()
          : d.execute(phase === "click" ? "element.click" : "app.state", {
              app: "test.editor",
              snapshotId: state.snapshotId,
              elementIndex: phase === "click" ? 1 : undefined,
            });
      await entered.promise;
      const retirement = d.driver.forceRetire();
      await d.external.stopEntered.promise;
      await d.external.exited;
      expect(d.external.live).toBe(false);
      expect(d.external.destroyed).toBe(false);
      expect(() => d.driver.select(d.definition)).toThrow();
      release.resolve();
      await Promise.allSettled([operation, retirement]);
      expect(d.external.destroyed).toBe(true);
      expect(d.driver.getCapabilities()).toEqual([]);
      expect(() => d.driver.acquireCommand()).toThrow();
    },
  );
});
