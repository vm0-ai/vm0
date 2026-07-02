import { describe, expect, it, vi } from "vitest";
import {
  ComputerUseSnapshotStore,
  executeComputerUseCommand,
  type AccessibilityAppStateSnapshot,
  type ComputerUseCoordinateBounds,
} from "./computer-use-accessibility";
import {
  ComputerUseNativeHelperError,
  type ComputerUseNativeBackend,
} from "./computer-use-native";

const permissions = { accessibility: true, screenRecording: true };

function nativeDispatchResult(
  dispatchMode: string,
  dispatchTarget: string,
  inputRisk: string,
): Record<string, unknown> {
  return { dispatchMode, dispatchTarget, inputRisk };
}

function createNativeBackend(
  overrides: Partial<ComputerUseNativeBackend> = {},
): ComputerUseNativeBackend {
  const defaults: ComputerUseNativeBackend = {
    dispose: () => {},
    getPermissions: async () => permissions,
    requestAccessibilityPermission: async () => permissions,
    requestScreenRecordingPermission: async () => permissions,
    probeAutomationPermission: async () => {
      return { status: "unknown", updatedAt: null, reason: null };
    },
    listApps: async () => [],
    getAppState: async (app, snapshotId) => {
      return appSnapshot(app, snapshotId);
    },
    openApp: async () => {
      return nativeDispatchResult(
        "background_app_open",
        "target_app",
        "background_app_launch",
      );
    },
    clickElement: async () => {
      return nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      );
    },
    clickPoint: async (args) => {
      return {
        ...nativeDispatchResult(
          "background_mouse_event",
          "app_process",
          "background_app_pointer",
        ),
        screenX: args.x,
        screenY: args.y,
      };
    },
    setElementValue: async () => {
      return nativeDispatchResult(
        "accessibility_value",
        "element",
        "targeted_app_text",
      );
    },
    performElementAction: async () => {
      return nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      );
    },
    typeText: async () => {
      return nativeDispatchResult(
        "accessibility_value",
        "focused_editable_element",
        "targeted_app_text",
      );
    },
    pressKey: async (args) => {
      return {
        ...nativeDispatchResult(
          "background_keyboard_event",
          "app_process",
          "background_app_shortcut",
        ),
        normalizedKey: args.key,
      };
    },
    scrollElement: async () => {
      return nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      );
    },
  };
  return { ...defaults, ...overrides };
}

interface NativeScreenshotFields {
  readonly screenshot: string;
  readonly screenshotMimeType: string;
  readonly screenshotSource: "window";
  readonly screenshotSourceName: string;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly screenshotSourceBounds: ComputerUseCoordinateBounds;
  readonly windowId: number;
  readonly windowFrame: ComputerUseCoordinateBounds;
}

function nativeScreenshotFields(
  overrides: Partial<NativeScreenshotFields> = {},
): NativeScreenshotFields {
  const sourceBounds =
    overrides.screenshotSourceBounds ??
    overrides.windowFrame ??
    ({
      x: 100,
      y: 200,
      width: 800,
      height: 600,
    } satisfies ComputerUseCoordinateBounds);
  return {
    screenshot: "data:image/png;base64,abc123",
    screenshotMimeType: "image/png",
    screenshotSource: "window",
    screenshotSourceName: "Example",
    screenshotWidth: 800,
    screenshotHeight: 600,
    screenshotSourceBounds: sourceBounds,
    windowId: 123,
    windowFrame: sourceBounds,
    ...overrides,
  };
}

function appSnapshot(
  app: string,
  snapshotId: string,
  overrides: Partial<AccessibilityAppStateSnapshot> = {},
): AccessibilityAppStateSnapshot {
  return {
    app,
    snapshotId,
    ...nativeScreenshotFields(),
    elements: [
      {
        id: "w0",
        role: "AXWindow",
        name: "Example",
        children: [
          {
            id: "w0.open",
            role: "AXButton",
            name: "Open",
            focused: true,
            actions: ["AXPress"],
            pressable: true,
            bounds: { x: 120, y: 260, width: 80, height: 32 },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function seedSnapshotStore(
  snapshotStore: ComputerUseSnapshotStore,
  options: {
    readonly app?: string;
    readonly snapshotId?: string;
    readonly elementIdsByIndex?: readonly string[];
  } = {},
): void {
  snapshotStore.set({
    app: options.app ?? "Safari",
    snapshotId: options.snapshotId ?? "snap_1",
    elementIdsByIndex: options.elementIdsByIndex ?? ["w0", "w0.input"],
    screenshotWidth: 800,
    screenshotHeight: 600,
    screenshotSource: "window",
    screenshotSourceName: "Example",
    sourceBounds: { x: 100, y: 200, width: 800, height: 600 },
    windowId: 123,
    windowFrame: { x: 100, y: 200, width: 800, height: 600 },
  });
}

describe("executeComputerUseCommand", () => {
  it("lists native apps with stable app-name and bundle-id sorting", async () => {
    const listApps = vi.fn<ComputerUseNativeBackend["listApps"]>(async () => {
      return [
        {
          name: "TextEdit",
          bundleId: "com.apple.TextEdit",
          appPath: "/System/Applications/TextEdit.app",
          running: true,
          pid: 42,
        },
        {
          name: "Safari",
          bundleId: "com.apple.Safari",
          appPath: "/Applications/Safari.app",
          running: false,
        },
        {
          name: "safari",
          bundleId: "com.apple.WebKit",
          appPath: "/Applications/WebKit.app",
          running: false,
        },
      ];
    });

    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "apps.list", payload: {} },
      permissions,
      { platform: "darwin", nativeBackend: createNativeBackend({ listApps }) },
    );

    expect(listApps).toHaveBeenCalledOnce();
    expect(result).toStrictEqual({
      status: "succeeded",
      result: {
        apps: [
          {
            name: "Safari",
            bundleId: "com.apple.Safari",
            appPath: "/Applications/Safari.app",
            running: false,
          },
          {
            name: "safari",
            bundleId: "com.apple.WebKit",
            appPath: "/Applications/WebKit.app",
            running: false,
          },
          {
            name: "TextEdit",
            bundleId: "com.apple.TextEdit",
            appPath: "/System/Applications/TextEdit.app",
            running: true,
            pid: 42,
          },
        ],
      },
    });
  });

  it("indexes native snapshots and renders model-readable app state", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const getAppState = vi.fn<ComputerUseNativeBackend["getAppState"]>(
      async (app, snapshotId, settle) => {
        return appSnapshot(app, snapshotId, {
          appDisplayName: "Things",
          windowTitle: "Inbox",
          elements: [
            {
              id: "w0",
              role: "AXWindow",
              name: "Inbox",
              children: [
                {
                  id: "w0.open",
                  role: "AXButton",
                  name: "Open",
                  focused: true,
                  actions: ["AXPress"],
                  pressable: true,
                  bounds: { x: 120, y: 260, width: 80, height: 32 },
                },
              ],
            },
          ],
          nodeCount: 2,
          truncated: false,
          ...(settle ? { windowTitle: "Settled" } : {}),
        });
      },
    );

    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Things" } },
      permissions,
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend: createNativeBackend({ getAppState }),
      },
    );

    expect(getAppState).toHaveBeenCalledWith(
      "Things",
      expect.stringMatching(/^desktop_/),
      false,
    );
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }
    expect(result.result).toMatchObject({
      app: "Things",
      appDisplayName: "Things",
      windowTitle: "Inbox",
      elementIdsByIndex: ["w0", "w0.open"],
      focusedElementIndex: 1,
      nodeCount: 2,
      truncated: false,
      screenshot: "data:image/png;base64,abc123",
      screenshotSource: "window",
      screenshotSourceName: "Example",
    });
    expect(result.result.appState).toContain("Computer Use state");
    expect(result.result.appState).toContain('Window: "Inbox", App: Things.');
    expect(result.result.appState).toContain("\t1 button Open");
    expect(result.result.appState).toContain(
      "The focused UI element is 1 button Open.",
    );
    expect(result.result.visibleText).toContain("1 AXButton [AXTitle] Open");
    expect(result.result.elements).toStrictEqual([
      {
        index: 0,
        role: "AXWindow",
        name: "Inbox",
        children: [
          {
            index: 1,
            role: "AXButton",
            name: "Open",
            focused: true,
            actions: ["AXPress"],
            pressable: true,
            bounds: { x: 120, y: 260, width: 80, height: 32 },
          },
        ],
      },
    ]);
    expect(
      snapshotStore.get("Things", String(result.result.snapshotId)),
    ).toMatchObject({
      elementIdsByIndex: ["w0", "w0.open"],
      focusedElementIndex: 1,
      screenshotSource: "window",
      screenshotWidth: 800,
      screenshotHeight: 600,
    });
  });

  it("resolves element indexes through the cached snapshot and returns a post-action snapshot", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    clickElement.mockResolvedValue(
      nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      ),
    );
    const getAppState = vi.fn<ComputerUseNativeBackend["getAppState"]>(
      async (app, snapshotId, settle) => {
        return appSnapshot(app, snapshotId, {
          windowTitle: settle === true ? "After click" : "Before click",
          elements: [
            {
              id: "w0",
              role: "AXWindow",
              name: settle === true ? "After click" : "Before click",
              children: [
                {
                  id: "w0.open",
                  role: "AXButton",
                  name: "Open",
                  actions: ["AXPress"],
                  pressable: true,
                },
              ],
            },
          ],
        });
      },
    );
    const nativeBackend = createNativeBackend({ clickElement, getAppState });

    const state = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Things" } },
      permissions,
      { platform: "darwin", snapshotStore, nativeBackend },
    );
    expect(state.status).toBe("succeeded");
    if (state.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }
    const snapshotId = String(state.result.snapshotId);

    const click = await executeComputerUseCommand(
      {
        id: "cmd_2",
        kind: "element.click",
        payload: { app: "Things", snapshotId, elementIndex: 1 },
      },
      permissions,
      { platform: "darwin", snapshotStore, nativeBackend },
    );

    expect(clickElement).toHaveBeenCalledWith({
      app: "Things",
      elementId: "w0.open",
      elementIndex: 1,
      snapshotId,
      button: "left",
      clickCount: 1,
      foregroundRecovery: "on-window-unavailable",
    });
    expect(getAppState).toHaveBeenLastCalledWith(
      "Things",
      expect.stringMatching(/^desktop_/),
      true,
    );
    expect(click).toMatchObject({
      status: "succeeded",
      result: {
        app: "Things",
        windowTitle: "After click",
        action: {
          app: "Things",
          snapshotId,
          elementIndex: 1,
          dispatchMode: "accessibility_action",
          dispatchTarget: "element",
          inputRisk: "targeted_app_action",
          summary: "Clicked elementIndex=1",
        },
      },
    });
  });

  it("prefetches a snapshot for coordinate clicks and re-snapshots after the click", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickPoint = vi.fn<ComputerUseNativeBackend["clickPoint"]>();
    clickPoint.mockResolvedValue({
      ...nativeDispatchResult(
        "background_mouse_event",
        "app_process",
        "background_app_pointer",
      ),
      screenX: 500,
      screenY: 450,
    });
    let firstSnapshotId: string | null = null;
    const getAppState = vi.fn<ComputerUseNativeBackend["getAppState"]>(
      async (app, snapshotId, settle) => {
        if (settle !== true) {
          firstSnapshotId = snapshotId;
        }
        return appSnapshot(app, snapshotId, {
          windowTitle: settle === true ? "Clicked" : "Ready",
          ...nativeScreenshotFields({
            screenshotSourceBounds: {
              x: 100,
              y: 150,
              width: 1600,
              height: 1200,
            },
            windowFrame: { x: 100, y: 150, width: 1600, height: 1200 },
          }),
        });
      },
    );

    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: {
          app: "Safari",
          x: 200,
          y: 150,
          button: "right",
          clickCount: 2,
        },
      },
      permissions,
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend: createNativeBackend({ clickPoint, getAppState }),
      },
    );

    expect(getAppState).toHaveBeenNthCalledWith(
      1,
      "Safari",
      expect.stringMatching(/^desktop_/),
      false,
    );
    expect(getAppState).toHaveBeenNthCalledWith(
      2,
      "Safari",
      expect.stringMatching(/^desktop_/),
      true,
    );
    expect(clickPoint).toHaveBeenCalledWith({
      app: "Safari",
      snapshotId: firstSnapshotId,
      x: 200,
      y: 150,
      screenshotSource: "window",
      screenshotWidth: 800,
      screenshotHeight: 600,
      sourceBounds: { x: 100, y: 150, width: 1600, height: 1200 },
      windowId: 123,
      windowFrame: { x: 100, y: 150, width: 1600, height: 1200 },
      button: "right",
      clickCount: 2,
      foregroundRecovery: "on-window-unavailable",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        windowTitle: "Clicked",
        action: {
          app: "Safari",
          snapshotId: firstSnapshotId,
          x: 200,
          y: 150,
          screenX: 500,
          screenY: 450,
          button: "right",
          clickCount: 2,
          dispatchMode: "background_mouse_event",
          dispatchTarget: "app_process",
          inputRisk: "background_app_pointer",
          summary: "Clicked 200,150",
        },
      },
    });
  });

  it("dispatches app and keyboard write commands and captures post-action snapshots", async () => {
    const openApp = vi.fn<ComputerUseNativeBackend["openApp"]>(async () => {
      return nativeDispatchResult(
        "background_app_open",
        "target_app",
        "background_app_launch",
      );
    });
    const typeText = vi.fn<ComputerUseNativeBackend["typeText"]>(async () => {
      return {
        ...nativeDispatchResult(
          "accessibility_value",
          "focused_editable_element",
          "targeted_app_text",
        ),
        role: "AXTextArea",
        description: "Message composer",
      };
    });
    const pressKey = vi.fn<ComputerUseNativeBackend["pressKey"]>(
      async (args) => {
        return {
          ...nativeDispatchResult(
            "background_keyboard_event",
            "app_process",
            "background_app_shortcut",
          ),
          normalizedKey: args.key.toUpperCase(),
        };
      },
    );
    const getAppState = vi.fn<ComputerUseNativeBackend["getAppState"]>(
      async (app, snapshotId) => {
        return appSnapshot(app, snapshotId, { windowTitle: "Post action" });
      },
    );
    const nativeBackend = createNativeBackend({
      openApp,
      typeText,
      pressKey,
      getAppState,
    });

    const open = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.open", payload: { app: "Notes" } },
      permissions,
      { platform: "darwin", nativeBackend },
    );
    const type = await executeComputerUseCommand(
      {
        id: "cmd_2",
        kind: "keyboard.type_text",
        payload: {
          app: "Notes",
          snapshotId: "snap_current",
          text: "hello",
          foregroundRecovery: "always",
        },
      },
      permissions,
      { platform: "darwin", nativeBackend },
    );
    const press = await executeComputerUseCommand(
      {
        id: "cmd_3",
        kind: "keyboard.press_key",
        payload: {
          app: "Notes",
          snapshotId: "snap_current",
          key: "enter",
          foregroundRecovery: "never",
        },
      },
      permissions,
      { platform: "darwin", nativeBackend },
    );

    expect(openApp).toHaveBeenCalledWith("Notes");
    expect(typeText).toHaveBeenCalledWith({
      app: "Notes",
      snapshotId: "snap_current",
      text: "hello",
      foregroundRecovery: "always",
    });
    expect(pressKey).toHaveBeenCalledWith({
      app: "Notes",
      snapshotId: "snap_current",
      key: "enter",
      foregroundRecovery: "never",
    });
    expect(getAppState).toHaveBeenCalledTimes(3);
    expect(getAppState).toHaveBeenNthCalledWith(
      1,
      "Notes",
      expect.stringMatching(/^desktop_/),
      true,
    );
    expect(getAppState).toHaveBeenNthCalledWith(
      2,
      "Notes",
      expect.stringMatching(/^desktop_/),
      true,
    );
    expect(getAppState).toHaveBeenNthCalledWith(
      3,
      "Notes",
      expect.stringMatching(/^desktop_/),
      true,
    );
    expect(open).toMatchObject({
      status: "succeeded",
      result: {
        windowTitle: "Post action",
        action: {
          app: "Notes",
          dispatchMode: "background_app_open",
          summary: "Opened Notes",
        },
      },
    });
    expect(type).toMatchObject({
      status: "succeeded",
      result: {
        windowTitle: "Post action",
        action: {
          app: "Notes",
          role: "AXTextArea",
          description: "Message composer",
          summary: "Typed text",
        },
      },
    });
    expect(press).toMatchObject({
      status: "succeeded",
      result: {
        windowTitle: "Post action",
        action: {
          app: "Notes",
          key: "ENTER",
          dispatchMode: "background_keyboard_event",
          summary: "Pressed ENTER",
        },
      },
    });
  });

  it("dispatches element mutation commands through element indexes", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    seedSnapshotStore(snapshotStore, { app: "Safari", snapshotId: "snap_1" });
    const scrollElement = vi.fn<ComputerUseNativeBackend["scrollElement"]>(
      async () => {
        return nativeDispatchResult(
          "accessibility_action",
          "element",
          "targeted_app_action",
        );
      },
    );
    const setElementValue = vi.fn<ComputerUseNativeBackend["setElementValue"]>(
      async () => {
        return nativeDispatchResult(
          "accessibility_value",
          "element",
          "targeted_app_text",
        );
      },
    );
    const performElementAction = vi.fn<
      ComputerUseNativeBackend["performElementAction"]
    >(async () => {
      return nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      );
    });
    const getAppState = vi.fn<ComputerUseNativeBackend["getAppState"]>(
      async (app, snapshotId) => {
        return appSnapshot(app, snapshotId, { windowTitle: "Post mutation" });
      },
    );
    const nativeBackend = createNativeBackend({
      scrollElement,
      setElementValue,
      performElementAction,
      getAppState,
    });

    const scroll = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.scroll",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          elementIndex: 1,
          direction: "down",
          pages: 2,
        },
      },
      permissions,
      { platform: "darwin", snapshotStore, nativeBackend },
    );
    const setValue = await executeComputerUseCommand(
      {
        id: "cmd_2",
        kind: "element.set_value",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          elementIndex: 1,
          value: "hello",
        },
      },
      permissions,
      { platform: "darwin", snapshotStore, nativeBackend },
    );
    const performAction = await executeComputerUseCommand(
      {
        id: "cmd_3",
        kind: "element.perform_action",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          elementIndex: 1,
          action: "AXConfirm",
        },
      },
      permissions,
      { platform: "darwin", snapshotStore, nativeBackend },
    );

    expect(scrollElement).toHaveBeenCalledWith({
      app: "Safari",
      elementId: "w0.input",
      elementIndex: 1,
      snapshotId: "snap_1",
      direction: "down",
      pages: 2,
    });
    expect(setElementValue).toHaveBeenCalledWith({
      app: "Safari",
      elementId: "w0.input",
      elementIndex: 1,
      snapshotId: "snap_1",
      value: "hello",
    });
    expect(performElementAction).toHaveBeenCalledWith({
      app: "Safari",
      elementId: "w0.input",
      elementIndex: 1,
      snapshotId: "snap_1",
      action: "AXConfirm",
    });
    expect(getAppState).toHaveBeenCalledTimes(3);
    expect(scroll).toMatchObject({
      status: "succeeded",
      result: {
        windowTitle: "Post mutation",
        action: { summary: "Scrolled elementIndex=1" },
      },
    });
    expect(setValue).toMatchObject({
      status: "succeeded",
      result: {
        windowTitle: "Post mutation",
        action: { summary: "Set elementIndex=1" },
      },
    });
    expect(performAction).toMatchObject({
      status: "succeeded",
      result: {
        windowTitle: "Post mutation",
        action: { summary: "Performed AXConfirm" },
      },
    });
  });

  it("fails before native dispatch when an element index is absent from the snapshot", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    seedSnapshotStore(snapshotStore, {
      app: "Safari",
      snapshotId: "snap_1",
      elementIdsByIndex: ["w0"],
    });

    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Safari", snapshotId: "snap_1", elementIndex: 9 },
      },
      permissions,
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend: createNativeBackend({ clickElement }),
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message: "Element index 9 was not found in snapshot snap_1",
      },
    });
    expect(clickElement).not.toHaveBeenCalled();
  });

  it("returns permission and payload failures before native dispatch", async () => {
    const getAppState = vi.fn<ComputerUseNativeBackend["getAppState"]>();
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    const scrollElement = vi.fn<ComputerUseNativeBackend["scrollElement"]>();
    const nativeBackend = createNativeBackend({
      getAppState,
      clickElement,
      scrollElement,
    });

    const noAccessibility = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: false, screenRecording: true },
      { platform: "darwin", nativeBackend },
    );
    const noScreenRecording = await executeComputerUseCommand(
      { id: "cmd_2", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: false },
      { platform: "darwin", nativeBackend },
    );
    const missingApp = await executeComputerUseCommand(
      { id: "cmd_3", kind: "element.click", payload: { elementId: "w0" } },
      permissions,
      { platform: "darwin", nativeBackend },
    );
    const missingDirection = await executeComputerUseCommand(
      {
        id: "cmd_4",
        kind: "element.scroll",
        payload: { app: "Safari", elementId: "w0" },
      },
      permissions,
      { platform: "darwin", nativeBackend },
    );
    const invalidElementIndex = await executeComputerUseCommand(
      {
        id: "cmd_5",
        kind: "element.click",
        payload: { app: "Safari", elementIndex: 1.5 },
      },
      permissions,
      { platform: "darwin", nativeBackend },
    );
    const unsupported = await executeComputerUseCommand(
      { id: "cmd_6", kind: "window.close", payload: { app: "Safari" } },
      permissions,
      { platform: "darwin", nativeBackend },
    );

    expect(noAccessibility).toStrictEqual({
      status: "failed",
      error: {
        code: "permission_denied",
        message: "macOS Accessibility permission is required",
      },
    });
    expect(noScreenRecording).toStrictEqual({
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: "macOS Screen Recording permission is required",
      },
    });
    expect(missingApp).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message: "Missing required payload field: app",
      },
    });
    expect(missingDirection).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message: "Missing required payload field: direction",
      },
    });
    expect(invalidElementIndex).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message: "elementIndex must be a non-negative integer",
      },
    });
    expect(unsupported).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message: "Unsupported command: window.close",
      },
    });
    expect(getAppState).not.toHaveBeenCalled();
    expect(clickElement).not.toHaveBeenCalled();
    expect(scrollElement).not.toHaveBeenCalled();
  });

  it("maps native helper failures into command failures", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "apps.list", payload: {} },
      permissions,
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          listApps: async () => {
            throw new ComputerUseNativeHelperError(
              "accessibility_unavailable",
              "Native helper exited before responding",
            );
          },
        }),
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "accessibility_unavailable",
        message: "Native helper exited before responding",
      },
    });
  });
});
