import { describe, expect, it, vi } from "vitest";
import {
  ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
  ComputerUseSnapshotStore,
  type ComputerUseCoordinateBounds,
  collectAccessibilityVisibleElements,
  executeComputerUseCommand,
  normalizeAccessibilitySnapshot,
  renderAccessibilityTree,
} from "./computer-use-accessibility";
import {
  ComputerUseNativeHelperError,
  resolveComputerUseHelperPath,
  type ComputerUseNativeBackend,
} from "./computer-use-native";
import {
  buildComputerUseRuntimeBody,
  resolveComputerUseApiBaseUrl,
} from "./computer-use-host";
import { resolveDesktopConfig } from "./config";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthStartUrl,
  buildDesktopAuthTokenUrl,
  createDesktopAuthStartGate,
  isDesktopAuthCompletionNavigation,
  isDesktopAuthSelectOrgNavigation,
  isDesktopAuthStartNavigation,
  isElectronNavigationAborted,
  parseDesktopAuthCallbackArgv,
  parseDesktopAuthCallback,
} from "./desktop-auth";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";

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
    getPermissions: async () => {
      return { accessibility: true, screenRecording: true };
    },
    requestAccessibilityPermission: async () => {
      return { accessibility: true, screenRecording: true };
    },
    requestScreenRecordingPermission: async () => {
      return { accessibility: true, screenRecording: true };
    },
    listApps: async () => [],
    getAppState: async (app, snapshotId) => {
      return { app, snapshotId, elements: [] };
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

function nativeAppStateWithScreenshot(
  app: string,
  snapshotId: string,
  sourceName = "Example",
) {
  return {
    app,
    snapshotId,
    ...nativeScreenshotFields({ screenshotSourceName: sourceName }),
    elements: [],
  };
}

describe("resolveDesktopConfig", () => {
  it("defaults to production", () => {
    const config = resolveDesktopConfig("");

    expect(config.platformUrl.toString()).toBe("https://app.vm0.ai/");
    expect(config.webUrl.toString()).toBe("https://www.vm0.ai/");
    expect(config.environment).toBe("production");
    expect(config.identity).toMatchObject({
      displayName: "Zero",
      bundleId: "ai.vm0.zero.desktop",
      authScheme: "ai.vm0.zero.desktop",
    });
    expect(config.sessionPartition).toBe("persist:vm0-desktop-production");
    expect([...config.allowedAppOrigins].sort()).toStrictEqual([
      "https://api.vm0.ai",
      "https://app.vm0.ai",
      "https://www.vm0.ai",
    ]);
  });

  it("recognizes staging", () => {
    const config = resolveDesktopConfig("https://staging-app.vm6.ai/");

    expect(config.environment).toBe("staging");
    expect(config.webUrl.toString()).toBe("https://staging-www.vm6.ai/");
    expect(config.identity).toMatchObject({
      displayName: "Zero Dev",
      bundleId: "ai.vm0.zero.desktop.dev",
      authScheme: "ai.vm0.zero.desktop.dev",
    });
    expect(config.sessionPartition).toBe("persist:vm0-desktop-staging");
    expect(config.allowedAppOrigins.has("https://staging-app.vm6.ai")).toBe(
      true,
    );
    expect(config.allowedAppOrigins.has("https://staging-www.vm6.ai")).toBe(
      true,
    );
    expect(config.allowedAppOrigins.has("https://staging-api.vm6.ai")).toBe(
      true,
    );
  });

  it("treats custom app hostnames as development", () => {
    const config = resolveDesktopConfig("https://app.vm7.ai:8443/");

    expect(config.environment).toBe("development");
    expect(config.webUrl.toString()).toBe("https://www.vm7.ai:8443/");
    expect(config.identity).toMatchObject({
      displayName: "Zero Dev",
      bundleId: "ai.vm0.zero.desktop.dev",
      authScheme: "ai.vm0.zero.desktop.dev",
    });
    expect(config.sessionPartition).toBe("persist:vm0-desktop-development");
    expect(config.allowedAppOrigins.has("https://app.vm7.ai:8443")).toBe(true);
    expect(config.allowedAppOrigins.has("https://www.vm7.ai:8443")).toBe(true);
    expect(config.allowedAppOrigins.has("https://api.vm7.ai:8443")).toBe(true);
  });

  it("derives matching origins for PR preview hostnames", () => {
    const config = resolveDesktopConfig("https://pr-123-app.vm6.ai/");

    expect(config.environment).toBe("development");
    expect(config.webUrl.toString()).toBe("https://pr-123-www.vm6.ai/");
    expect(config.identity).toMatchObject({
      displayName: "Zero Dev",
      bundleId: "ai.vm0.zero.desktop.dev",
      authScheme: "ai.vm0.zero.desktop.dev",
    });
    expect([...config.allowedAppOrigins].sort()).toStrictEqual([
      "https://pr-123-api.vm6.ai",
      "https://pr-123-app.vm6.ai",
      "https://pr-123-www.vm6.ai",
    ]);
  });

  it("derives localhost companion origins from the app port", () => {
    const config = resolveDesktopConfig("http://localhost:3002");

    expect(config.environment).toBe("development");
    expect(config.webUrl.toString()).toBe("http://localhost:3000/");
    expect([...config.allowedAppOrigins].sort()).toStrictEqual([
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
    ]);
  });
});

describe("window policy", () => {
  const allowedOrigins = new Set(["https://app.vm0.ai", "https://www.vm0.ai"]);

  it("allows app-origin navigation", () => {
    expect(
      isAllowedAppNavigation("https://www.vm0.ai/connectors", allowedOrigins),
    ).toBe(true);
  });

  it("blocks unexpected main-window navigation", () => {
    expect(
      isAllowedAppNavigation("https://example.com/docs", allowedOrigins),
    ).toBe(false);
  });

  it("opens app-origin windows inside Electron", () => {
    expect(
      decideWindowOpen("https://app.vm0.ai/connectors", allowedOrigins),
    ).toStrictEqual({ action: "allow-in-app" });
  });

  it("keeps Google OAuth windows external", () => {
    expect(
      decideWindowOpen(
        "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fmock-instance.clerk.accounts.dev%2Fv1%2Foauth_callback&state=abc",
        allowedOrigins,
      ),
    ).toStrictEqual({
      action: "open-external",
      url: "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fmock-instance.clerk.accounts.dev%2Fv1%2Foauth_callback&state=abc",
    });
  });

  it("keeps ordinary GitHub links external", () => {
    expect(
      decideWindowOpen("https://github.com/vm0-ai/vm0", allowedOrigins),
    ).toStrictEqual({
      action: "open-external",
      url: "https://github.com/vm0-ai/vm0",
    });
  });

  it("opens ordinary http links externally", () => {
    expect(
      decideWindowOpen("https://example.com/docs", allowedOrigins),
    ).toStrictEqual({
      action: "open-external",
      url: "https://example.com/docs",
    });
  });

  it("opens mailto links externally", () => {
    expect(
      decideWindowOpen("mailto:support@vm0.ai", allowedOrigins),
    ).toStrictEqual({
      action: "open-external",
      url: "mailto:support@vm0.ai",
    });
  });

  it("denies unsafe protocols", () => {
    expect(
      decideWindowOpen("javascript:alert('nope')", allowedOrigins),
    ).toStrictEqual({ action: "deny" });
  });
});

describe("computer use native helper", () => {
  it("prefers the packaged helper path when it exists", () => {
    const packagedPath = "/resources/native/computer-use-helper";
    const localPath = "/app/native/dist/native/computer-use-helper";
    const existing = new Set([packagedPath, localPath]);

    expect(
      resolveComputerUseHelperPath({
        appRoot: "/app",
        resourcesPath: "/resources",
        exists: (candidate) => {
          return existing.has(candidate);
        },
      }),
    ).toBe(packagedPath);
  });

  it("falls back to the local dist helper path", () => {
    expect(
      resolveComputerUseHelperPath({
        appRoot: "/app",
        resourcesPath: "/resources",
        exists: () => {
          return false;
        },
      }),
    ).toBe("/app/native/dist/native/computer-use-helper");
  });
});

describe("desktop auth", () => {
  const allowedOrigins = new Set(["https://app.vm0.ai", "https://www.vm0.ai"]);
  const webUrl = new URL("https://www.vm0.ai");
  const code = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";

  it("builds the production system-browser desktop auth start URL", () => {
    expect(buildDesktopAuthStartUrl(webUrl, "ai.vm0.zero.desktop")).toBe(
      "https://www.vm0.ai/desktop-auth/start?callbackScheme=ai.vm0.zero.desktop",
    );
  });

  it("builds the development system-browser desktop auth start URL", () => {
    expect(
      buildDesktopAuthStartUrl(
        new URL("https://www.vm7.ai:8443"),
        "ai.vm0.zero.desktop.dev",
      ),
    ).toBe(
      "https://www.vm7.ai:8443/desktop-auth/start?callbackScheme=ai.vm0.zero.desktop.dev",
    );
  });

  it("deduplicates repeated desktop auth start attempts", () => {
    let now = 1_000;
    const gate = createDesktopAuthStartGate(() => now);

    expect(gate.shouldOpen()).toBe(true);
    expect(gate.shouldOpen()).toBe(false);

    now += 30_000;
    expect(gate.shouldOpen()).toBe(true);
    expect(gate.shouldOpen()).toBe(false);

    now += 30_000;
    gate.suppressRetry();
    expect(gate.shouldOpen()).toBe(false);

    now += 30_000;
    expect(gate.shouldOpen()).toBe(true);
  });

  it("detects explicit desktop auth start navigation", () => {
    expect(
      isDesktopAuthStartNavigation(
        "https://app.vm0.ai/sign-in",
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      isDesktopAuthStartNavigation(
        "https://app.vm0.ai/desktop-auth/start",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthStartNavigation(
        "https://www.vm0.ai/desktop-auth/start",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthStartNavigation(
        "https://accounts.google.com/signin",
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it("parses a valid desktop callback code", () => {
    expect(
      parseDesktopAuthCallback(
        `ai.vm0.zero.desktop://auth/callback?code=${code}`,
        "ai.vm0.zero.desktop",
      ),
    ).toStrictEqual({ code });
    expect(
      parseDesktopAuthCallback(
        `ai.vm0.zero.desktop.dev://auth/callback?code=${code}`,
        "ai.vm0.zero.desktop.dev",
      ),
    ).toStrictEqual({ code });
  });

  it("parses desktop callbacks from launch arguments", () => {
    expect(
      parseDesktopAuthCallbackArgv(
        [
          "/Applications/Zero.app/Contents/MacOS/Zero",
          `ai.vm0.zero.desktop://auth/callback?code=${code}`,
        ],
        "ai.vm0.zero.desktop",
      ),
    ).toStrictEqual({ code });
    expect(
      parseDesktopAuthCallbackArgv(
        ["/Applications/Zero.app/Contents/MacOS/Zero", "--some-flag"],
        "ai.vm0.zero.desktop",
      ),
    ).toBe(null);
  });

  it("rejects unsafe desktop callbacks", () => {
    expect(
      parseDesktopAuthCallback(
        "ai.vm0.zero.desktop://auth/callback?token=secret",
        "ai.vm0.zero.desktop",
      ),
    ).toBe(null);
    expect(
      parseDesktopAuthCallback(
        `ai.vm0.zero.desktop://auth/callback?code=${code}`,
        "ai.vm0.zero.desktop.dev",
      ),
    ).toBe(null);
    expect(
      parseDesktopAuthCallback(
        "ai.vm0.zero.desktop://other/callback?code=abc",
        "ai.vm0.zero.desktop",
      ),
    ).toBe(null);
    expect(
      parseDesktopAuthCallback(
        "https://app.vm0.ai/desktop-auth/consume?code=abc",
        "ai.vm0.zero.desktop",
      ),
    ).toBe(null);
  });

  it("does not treat legacy callbacks as valid", () => {
    expect(
      parseDesktopAuthCallback(
        `vm0://auth/callback?code=${code}`,
        "ai.vm0.zero.desktop",
      ),
    ).toBe(null);
    expect(
      parseDesktopAuthCallback(
        `vm0://auth/callback?code=${code}`,
        "ai.vm0.zero.desktop.dev",
      ),
    ).toBe(null);
  });

  it("builds the Electron web-session consume URL", () => {
    expect(buildDesktopAuthConsumeUrl(webUrl, code)).toBe(
      `https://www.vm0.ai/desktop-auth/consume?code=${code}`,
    );
  });

  it("builds the Electron web-session organization selection URL", () => {
    expect(buildDesktopAuthSelectOrgUrl(webUrl)).toBe(
      "https://www.vm0.ai/desktop-auth/select-org",
    );
    expect(buildDesktopAuthSelectOrgUrl(webUrl, true)).toBe(
      "https://www.vm0.ai/desktop-auth/select-org?force=true",
    );
  });

  it("builds the Electron web-session token refresh URL", () => {
    expect(buildDesktopAuthTokenUrl(webUrl)).toBe(
      "https://www.vm0.ai/desktop-auth/token",
    );
  });

  it("detects desktop auth organization selection navigation", () => {
    expect(
      isDesktopAuthSelectOrgNavigation(
        "https://app.vm0.ai/desktop-auth/select-org",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthSelectOrgNavigation(
        "https://www.vm0.ai/desktop-auth/select-org?force=true",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthSelectOrgNavigation(
        "https://accounts.google.com/signin",
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it("detects desktop auth completion navigation after locale redirects", () => {
    expect(
      isDesktopAuthCompletionNavigation("https://www.vm0.ai/", allowedOrigins),
    ).toBe(true);
    expect(
      isDesktopAuthCompletionNavigation(
        "https://www.vm0.ai/en",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthCompletionNavigation(
        "https://www.vm0.ai/desktop-auth/token",
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      isDesktopAuthCompletionNavigation(
        "https://accounts.google.com/signin",
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it("recognizes Electron navigation aborts as non-fatal auth redirects", () => {
    expect(isElectronNavigationAborted({ code: "ERR_ABORTED" })).toBe(true);
    expect(isElectronNavigationAborted({ errno: -3 })).toBe(true);
    expect(isElectronNavigationAborted({ code: "ERR_FAILED" })).toBe(false);
    expect(isElectronNavigationAborted(null)).toBe(false);
  });
});

describe("computer use desktop runtime", () => {
  it("derives the API backend URL from platform URLs", () => {
    expect(resolveComputerUseApiBaseUrl(new URL("https://app.vm0.ai"))).toBe(
      "https://api.vm0.ai",
    );
    expect(resolveComputerUseApiBaseUrl(new URL("https://app.vm7.ai"))).toBe(
      "https://api.vm7.ai",
    );
    expect(
      resolveComputerUseApiBaseUrl(new URL("https://staging-app.vm6.ai")),
    ).toBe("https://staging-api.vm6.ai");
    expect(
      resolveComputerUseApiBaseUrl(new URL("https://pr-123-app.vm6.ai")),
    ).toBe("https://pr-123-api.vm6.ai");
  });

  it("serializes the Desktop host runtime body", () => {
    expect(
      buildComputerUseRuntimeBody({
        displayName: "Zero Desktop",
        appVersion: "0.1.0",
        permissions: { accessibility: true, screenRecording: false },
      }),
    ).toMatchObject({
      hostName: "Zero Desktop",
      appVersion: "0.1.0",
      permissions: { accessibility: true, screenRecording: false },
    });
  });

  it("lists app records with bundle identifiers", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "apps.list", payload: {} },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          listApps: async () => [
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
          ],
        }),
      },
    );

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

  it("reports app open as a background launch without target preparation", async () => {
    const openApp = vi.fn<ComputerUseNativeBackend["openApp"]>();
    openApp.mockResolvedValue({
      ...nativeDispatchResult(
        "background_app_open",
        "target_app",
        "background_app_launch",
      ),
      frontmostRestored: true,
      frontmostBefore: {
        localizedName: "Notes",
        pid: 200,
      },
      frontmostAfter: {
        localizedName: "Notes",
        pid: 200,
      },
    });
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.open", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          openApp,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Safari",
          dispatchMode: "background_app_open",
          dispatchTarget: "target_app",
          inputRisk: "background_app_launch",
          frontmostRestored: true,
          frontmostBefore: {
            localizedName: "Notes",
            pid: 200,
          },
          frontmostAfter: {
            localizedName: "Notes",
            pid: 200,
          },
        },
      },
    });
    expect(openApp).toHaveBeenCalledWith("Safari");
  });

  it("renders model-readable accessibility state", () => {
    const snapshot = {
      app: "Safari",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Example",
          children: [
            {
              id: "w0.e0",
              role: "AXButton",
              name: "Open",
              actions: ["AXPress"],
            },
          ],
        },
      ],
    };
    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain("Computer Use state");
    expect(text).toContain("<app_state>");
    expect(text).toContain("App=Safari");
    expect(text).toContain('Window: "Example", App: Safari.');
    expect(text).toContain("0 standard window Example");
    expect(text).toContain("\t1 button Open");
    expect(text).not.toContain("w0.e0");
  });

  it("renders CUA-style element details and focused element summary", () => {
    const snapshot = {
      app: "Electron",
      appDisplayName: "Zero",
      bundleId: "com.github.Electron",
      pid: 26037,
      appPath: "/Applications/Zero.app",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Zero | VM0",
          children: [
            {
              id: "w0.e0",
              role: "AXWebArea",
              roleDescription: "HTML content",
              name: "Zero | VM0",
              url: "https://app.vm7.ai/agents/1/chat",
              children: [
                {
                  id: "w0.e0.e0",
                  role: "AXTextArea",
                  name: "Ask me to automate workflows",
                  valueSettable: true,
                  valueType: "string",
                  focused: true,
                },
                {
                  id: "w0.e0.e1",
                  role: "AXButton",
                  description: "Invite people",
                  actions: ["AXPress", "AXRaise"],
                },
              ],
            },
          ],
        },
      ],
    };

    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain(
      "App=/Applications/Zero.app (bundleID com.github.Electron, pid 26037)",
    );
    expect(text).toContain(
      "\t1 HTML content Zero | VM0, URL: https://app.vm7.ai/agents/1/chat",
    );
    expect(text).toContain(
      "\t\t2 text entry area (settable, string) Ask me to automate workflows",
    );
    expect(text).toContain(
      "\t\t3 button Invite people, Secondary Actions: Raise",
    );
    expect(text).toContain(
      "The focused UI element is 2 text entry area (settable, string) Ask me to automate workflows.",
    );
  });

  it("renders click capability annotations for model target selection", () => {
    const snapshot = {
      app: "Things",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Things",
          children: [
            {
              id: "w0.r0",
              role: "AXRow",
              description: "Inbox",
              selected: false,
              selectable: true,
              mouseClickable: true,
              clickableKind: "select",
            },
            {
              id: "w0.r1",
              role: "AXRow",
              description: "Today",
              selected: true,
              selectable: true,
              mouseClickable: true,
              clickableKind: "select",
            },
            {
              id: "w0.g0",
              role: "AXGroup",
              name: "Reveal details",
              actions: ["AXPress"],
              pressable: true,
              clickableKind: "press",
            },
            {
              id: "w0.m0",
              role: "AXMenuItem",
              name: "Choose workspace",
              actions: ["AXPick"],
              pickable: true,
              clickableKind: "pick",
            },
          ],
        },
      ],
    } as const;

    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain("\t1 row (selectable) Inbox");
    expect(text).toContain("\t2 row (selected) Today");
    expect(text).toContain("\t3 container (pressable) Reveal details");
    expect(text).toContain("\t4 menu item (pickable) Choose workspace");
    expect(text).not.toContain("Secondary Actions: Pick");
  });

  it("builds an AX-derived visible element summary", () => {
    const snapshot = normalizeAccessibilitySnapshot({
      app: "Things",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Things",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: [
            {
              id: "w0.a0",
              role: "AXRow",
              description: "Hello Computer Use",
              selected: true,
              selectable: true,
              mouseClickable: true,
              clickableKind: "select",
              bounds: { x: 24, y: 120, width: 360, height: 24 },
            },
            {
              id: "w0.a1",
              role: "AXRow",
              help: "Can you see this?",
              selectable: true,
              mouseClickable: true,
              clickableKind: "select",
              bounds: { x: 24, y: 152, width: 360, height: 24 },
            },
            {
              id: "w0.a2",
              role: "AXRow",
              value: "Hidden old task",
              hidden: true,
              bounds: { x: 24, y: 184, width: 360, height: 24 },
            },
            {
              id: "w0.a3",
              role: "AXRow",
              value: "Scrolled away task",
              bounds: { x: 24, y: 900, width: 360, height: 24 },
            },
          ],
        },
      ],
    });

    const visibleElements = collectAccessibilityVisibleElements(snapshot, {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });

    expect(visibleElements).toStrictEqual([
      {
        elementId: "w0",
        role: "AXWindow",
        text: "Things",
        source: "accessibility",
        sourceAttributes: ["AXTitle"],
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
      {
        elementId: "w0.a0",
        role: "AXRow",
        text: "Hello Computer Use",
        source: "accessibility",
        sourceAttributes: ["AXDescription"],
        bounds: { x: 24, y: 120, width: 360, height: 24 },
        selected: true,
        selectable: true,
        mouseClickable: true,
        clickableKind: "select",
      },
      {
        elementId: "w0.a1",
        role: "AXRow",
        text: "Can you see this?",
        source: "accessibility",
        sourceAttributes: ["AXHelp"],
        bounds: { x: 24, y: 152, width: 360, height: 24 },
        selectable: true,
        mouseClickable: true,
        clickableKind: "select",
      },
    ]);
  });

  it("compacts generic wrappers while preserving WebArea branching context", () => {
    const snapshot = {
      app: "Slack",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "release-notify (Channel) - VM0 - Slack",
          children: [
            {
              id: "w0.e0",
              role: "AXGroup",
              children: [
                {
                  id: "w0.e0.e0",
                  role: "AXWebArea",
                  roleDescription: "HTML content",
                  children: [
                    {
                      id: "w0.e0.e0.e0",
                      role: "AXGroup",
                      children: [
                        {
                          id: "w0.e0.e0.e0.e0",
                          role: "AXGroup",
                          children: [
                            {
                              id: "w0.e0.e0.e0.e0.e0",
                              role: "AXButton",
                              name: "Send message",
                              actions: ["AXPress"],
                            },
                          ],
                        },
                        {
                          id: "w0.e0.e0.e0.e1",
                          role: "AXStaticText",
                          value: "release-notify",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const text = renderAccessibilityTree(
      normalizeAccessibilitySnapshot(snapshot),
    );

    expect(text).not.toContain("w0.e0");
    expect(text).toContain("\t1 HTML content");
    expect(text).toContain("\t\t2 container");
    expect(text).toContain("\t\t\t3 button Send message");
    expect(text).toContain("\t\t\t4 text release-notify");
  });

  it("renders browser table row and cell content for model targeting", () => {
    const snapshot = normalizeAccessibilitySnapshot({
      app: "Google Chrome",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Members | VM0 | Cloudflare",
          children: [
            {
              id: "w0.e0",
              role: "AXWebArea",
              roleDescription: "HTML content",
              name: "Members | VM0 | Cloudflare",
              children: [
                {
                  id: "w0.e0.e0",
                  role: "AXTable",
                  children: [
                    {
                      id: "w0.e0.e0.r0",
                      role: "AXRow",
                      children: [
                        {
                          id: "w0.e0.e0.r0.c0",
                          role: "AXCell",
                          children: [
                            {
                              id: "w0.e0.e0.r0.c0.t0",
                              role: "AXStaticText",
                              value: "Individual Domains",
                            },
                          ],
                        },
                        {
                          id: "w0.e0.e0.r0.c1",
                          role: "AXCell",
                          children: [
                            {
                              id: "w0.e0.e0.r0.c1.t0",
                              role: "AXStaticText",
                              value: "Domain DNS",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      id: "w0.e0.e0.r1",
                      role: "AXRow",
                      children: [
                        {
                          id: "w0.e0.e0.r1.c0",
                          role: "AXCell",
                          children: [
                            {
                              id: "w0.e0.e0.r1.c0.t0",
                              role: "AXStaticText",
                              value:
                                "Cloudflare Zero Trust; Load Balancer; Cloudflare Access",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain("table");
    expect(text).toContain("row");
    expect(text).toContain("cell");
    expect(text).toContain("Individual Domains");
    expect(text).toContain("Domain DNS");
    expect(text).toContain("Cloudflare Zero Trust; Load Balancer");
  });

  it("marks accessibility snapshots truncated at the output node budget", () => {
    const snapshot = {
      app: "Slack",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Slack",
          children: Array.from({ length: 5 }, (_value, index) => {
            return {
              id: `w0.e${index}`,
              role: "AXButton",
              name: `Button ${index}`,
            };
          }),
        },
      ],
    };

    const normalized = normalizeAccessibilitySnapshot(snapshot, {
      ...ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
      maxNodes: 3,
    });
    const text = renderAccessibilityTree(normalized);

    expect(normalized.truncated).toBe(true);
    expect(normalized.truncationReasons).toContain("max_nodes");
    expect(normalized.nodeCount).toBe(3);
    expect(text).toContain("\t1 button Button 0");
    expect(text).toContain("\t2 button Button 1");
    expect(text).not.toContain("Button 2");
  });

  it("returns screenshot metadata with model-readable app state", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          getAppState: async (app, snapshotId) => {
            return {
              app,
              snapshotId,
              ...nativeScreenshotFields({
                screenshotSourceName: "Example",
              }),
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "Example",
                },
              ],
            };
          },
        }),
      },
    );

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }
    expect(result).toMatchObject({
      result: {
        app: "Safari",
        snapshotId: expect.stringMatching(/^desktop_/),
        visibleTextSource: "accessibility",
        visibleText: "0 AXWindow [AXTitle] Example",
        visibleElements: [
          {
            elementIndex: 0,
            elementId: "w0",
            role: "AXWindow",
            text: "Example",
            source: "accessibility",
            sourceAttributes: ["AXTitle"],
          },
        ],
        screenshot: "data:image/png;base64,abc123",
        screenshotMimeType: "image/png",
        screenshotSource: "window",
        screenshotSourceName: "Example",
        screenshotWidth: 800,
        screenshotHeight: 600,
        screenshotSourceBounds: { x: 100, y: 200, width: 800, height: 600 },
      },
    });
    expect(result.result.appState).toContain("0 standard window Example");
    expect(result.result.elements).toStrictEqual([
      {
        index: 0,
        role: "AXWindow",
        name: "Example",
      },
    ]);
  });

  it("normalizes deep accessibility state from the native helper", async () => {
    const nativeRequests: {
      readonly app: string;
      readonly snapshotId: string;
    }[] = [];
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Slack" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          getAppState: async (app, snapshotId) => {
            nativeRequests.push({ app, snapshotId });
            return {
              app,
              snapshotId,
              ...nativeScreenshotFields({
                screenshotSourceName: "Slack",
              }),
              nodeCount: 7,
              truncated: false,
              truncationReasons: [],
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "release-notify (Channel) - VM0 - Slack",
                  children: [
                    {
                      id: "w0.e0",
                      role: "AXGroup",
                      children: [
                        {
                          id: "w0.e0.e0",
                          role: "AXGroup",
                          children: [
                            {
                              id: "w0.e0.e0.c0",
                              role: "AXWebArea",
                              roleDescription: "HTML content",
                              children: [
                                {
                                  id: "w0.e0.e0.c0.v0",
                                  role: "AXStaticText",
                                  value: "Release notes posted",
                                },
                                {
                                  id: "w0.e0.e0.c0.v1",
                                  role: "AXTextArea",
                                  name: "Message composer",
                                  placeholderValue: "Type a message",
                                  actions: ["AXConfirm"],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          },
        }),
      },
    );

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests[0]).toMatchObject({
      app: "Slack",
      snapshotId: expect.stringMatching(/^desktop_/),
    });
    expect(result.result.appState).toContain("Release notes posted");
    expect(result.result.appState).toContain(
      "text entry area Message composer",
    );
    expect(result.result.appState).toContain("Secondary Actions: Confirm");
    expect(result.result.visibleText).toContain(
      "AXStaticText [AXValue] Release notes posted",
    );
    expect(result.result.visibleElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          elementIndex: expect.any(Number),
          elementId: "w0.e0.e0.c0.v1",
          role: "AXTextArea",
          text: "Message composer",
          source: "accessibility",
          sourceAttributes: ["AXTitle"],
          actions: ["AXConfirm"],
        }),
      ]),
    );
    expect(result.result.truncated).toBe(false);
  });

  it("resolves action element ids from non-uiElement child sources", async () => {
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    clickElement.mockResolvedValue(
      nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      ),
    );
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Slack", elementId: "w0.c0.v2" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          clickElement,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId, "Slack");
          },
        }),
      },
    );

    expect(result.status).toBe("succeeded");
    expect(clickElement).toHaveBeenCalledWith({
      app: "Slack",
      elementId: "w0.c0.v2",
      button: "left",
      clickCount: 1,
    });
    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Slack",
          elementId: "w0.c0.v2",
          dispatchMode: "accessibility_action",
        },
      },
    });
  });

  it("returns fresh app state and screenshot after element clicks", async () => {
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    clickElement.mockResolvedValue(
      nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      ),
    );
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Things", elementId: "sidebar.inbox" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          clickElement,
          getAppState: async (app, snapshotId) => {
            return {
              app,
              snapshotId,
              ...nativeScreenshotFields({ screenshotSourceName: "Inbox" }),
              windowTitle: "Inbox",
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "Inbox",
                  children: [
                    {
                      id: "w0.todo0",
                      role: "AXStaticText",
                      value: "Can you see this?",
                    },
                  ],
                },
              ],
            };
          },
        }),
      },
    );

    expect(clickElement).toHaveBeenCalledWith({
      app: "Things",
      elementId: "sidebar.inbox",
      button: "left",
      clickCount: 1,
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected click to succeed");
    }
    expect(result.result).toMatchObject({
      app: "Things",
      windowTitle: "Inbox",
      screenshot: "data:image/png;base64,abc123",
      screenshotSourceName: "Inbox",
      action: {
        app: "Things",
        elementId: "sidebar.inbox",
        dispatchMode: "accessibility_action",
        summary: "Clicked sidebar.inbox",
      },
    });
    expect(result.result.appState).toContain("Can you see this?");
    expect(result.result.visibleText).toContain("Can you see this?");
  });

  it("resolves normalized element indexes to native element ids", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    clickElement.mockResolvedValue(
      nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      ),
    );
    const nativeBackend = createNativeBackend({
      clickElement,
      getAppState: async (app, snapshotId) => {
        return {
          app,
          snapshotId,
          ...nativeScreenshotFields({
            screenshotSourceName: "Example",
          }),
          elements: [
            {
              id: "w0",
              role: "AXWindow",
              name: "Example",
              children: [
                {
                  id: "w0.e0",
                  role: "AXGroup",
                  children: [
                    {
                      id: "w0.e0.e0",
                      role: "AXButton",
                      name: "Open",
                      actions: ["AXPress"],
                    },
                  ],
                },
              ],
            },
          ],
          elementIdsByIndex: ["w0", "w0.e0", "w0.e0.e0"],
        };
      },
    });

    const state = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend,
      },
    );
    expect(state.status).toBe("succeeded");
    if (state.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }

    const snapshotId = state.result.snapshotId;
    expect(typeof snapshotId).toBe("string");
    if (typeof snapshotId !== "string") {
      throw new Error("expected snapshot id");
    }
    expect(state.result.elements).toStrictEqual([
      {
        index: 0,
        role: "AXWindow",
        name: "Example",
        children: [
          {
            index: 1,
            role: "AXButton",
            name: "Open",
            actions: ["AXPress"],
          },
        ],
      },
    ]);

    const click = await executeComputerUseCommand(
      {
        id: "cmd_2",
        kind: "element.click",
        payload: { app: "Safari", snapshotId, elementIndex: 1 },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend,
      },
    );

    expect(click.status).toBe("succeeded");
    expect(clickElement).toHaveBeenCalledWith({
      app: "Safari",
      elementId: "w0.e0.e0",
      snapshotId,
      elementIndex: 1,
      button: "left",
      clickCount: 1,
    });
    if (click.status !== "succeeded") {
      throw new Error("expected click to succeed");
    }
    expect(click.result).toMatchObject({
      app: "Safari",
      screenshot: "data:image/png;base64,abc123",
      action: {
        app: "Safari",
        snapshotId,
        elementIndex: 1,
        dispatchMode: "accessibility_action",
      },
    });
    const action = click.result.action;
    expect(action).toBeTruthy();
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error("expected click action metadata");
    }
    expect(action).not.toHaveProperty("elementId");
  });

  it("maps screenshot coordinate clicks through cached snapshot bounds", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickPoint = vi.fn<ComputerUseNativeBackend["clickPoint"]>();
    clickPoint.mockResolvedValue({
      ...nativeDispatchResult(
        "background_mouse_event",
        "app_process",
        "background_app_pointer",
      ),
      screenX: 900,
      screenY: 800,
    });
    const nativeBackend = createNativeBackend({
      clickPoint,
      getAppState: async (app) => {
        return {
          app,
          snapshotId: "snap_1",
          ...nativeScreenshotFields({
            screenshotSourceName: "Example",
            screenshotWidth: 800,
            screenshotHeight: 600,
            screenshotSourceBounds: {
              x: 100,
              y: 200,
              width: 1600,
              height: 1200,
            },
            windowFrame: { x: 100, y: 200, width: 1600, height: 1200 },
          }),
          elements: [
            {
              id: "w0",
              role: "AXWindow",
              name: "Example",
              bounds: { x: 100, y: 200, width: 1600, height: 1200 },
            },
          ],
        };
      },
    });

    const state = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend,
      },
    );
    expect(state.status).toBe("succeeded");
    expect(snapshotStore.get("Safari", "snap_1")).toMatchObject({
      screenshotSource: "window",
      sourceBounds: { x: 100, y: 200, width: 1600, height: 1200 },
      windowId: 123,
      windowFrame: { x: 100, y: 200, width: 1600, height: 1200 },
    });

    const click = await executeComputerUseCommand(
      {
        id: "cmd_2",
        kind: "element.click",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          x: 400,
          y: 300,
          button: "right",
          clickCount: 2,
        },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend,
      },
    );

    expect(click).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Safari",
          snapshotId: "snap_1",
          x: 400,
          y: 300,
          screenX: 900,
          screenY: 800,
          button: "right",
          clickCount: 2,
          dispatchMode: "background_mouse_event",
          dispatchTarget: "app_process",
          inputRisk: "background_app_pointer",
        },
      },
    });
    expect(clickPoint).toHaveBeenCalledWith({
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
    });
  });

  it("surfaces native rejection for coordinate clicks against non-window snapshots", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickPoint = vi.fn<ComputerUseNativeBackend["clickPoint"]>();
    clickPoint.mockRejectedValue(
      new ComputerUseNativeHelperError(
        "unsupported_command",
        "Snapshot is not a target-window screenshot: screen_snap",
      ),
    );
    snapshotStore.set({
      app: "Safari",
      snapshotId: "screen_snap",
      screenshotWidth: 800,
      screenshotHeight: 600,
      screenshotSource: "screen",
      screenshotSourceName: "Built-in Display",
      sourceBounds: { x: 0, y: 0, width: 1440, height: 900 },
    });

    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: {
          app: "Safari",
          snapshotId: "screen_snap",
          x: 400,
          y: 300,
        },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend: createNativeBackend({ clickPoint }),
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message: "Snapshot is not a target-window screenshot: screen_snap",
      },
    });
    expect(clickPoint).toHaveBeenCalledWith({
      app: "Safari",
      snapshotId: "screen_snap",
      x: 400,
      y: 300,
      screenshotSource: "screen",
      screenshotWidth: 800,
      screenshotHeight: 600,
      sourceBounds: { x: 0, y: 0, width: 1440, height: 900 },
      button: "left",
      clickCount: 1,
    });
  });

  it("uses fresh native app state for coordinate clicks without a cached snapshot", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    let stateCaptureCount = 0;
    const clickPoint = vi.fn<ComputerUseNativeBackend["clickPoint"]>();
    clickPoint.mockResolvedValue({
      ...nativeDispatchResult(
        "background_mouse_event",
        "app_process",
        "background_app_pointer",
      ),
      screenX: 440,
      screenY: 380,
    });

    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Safari", x: 200, y: 150 },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend: createNativeBackend({
          clickPoint,
          getAppState: async () => {
            stateCaptureCount += 1;
            return {
              app: "Safari",
              snapshotId: "snap_fresh",
              ...nativeScreenshotFields({
                screenshotSourceName: "Example",
                screenshotWidth: 400,
                screenshotHeight: 300,
                screenshotSourceBounds: {
                  x: 40,
                  y: 80,
                  width: 800,
                  height: 600,
                },
                windowFrame: { x: 40, y: 80, width: 800, height: 600 },
              }),
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "Example",
                  bounds: { x: 40, y: 80, width: 800, height: 600 },
                },
              ],
            };
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Safari",
          snapshotId: "snap_fresh",
          x: 200,
          y: 150,
          screenX: 440,
          screenY: 380,
          button: "left",
          clickCount: 1,
          dispatchMode: "background_mouse_event",
          dispatchTarget: "app_process",
          inputRisk: "background_app_pointer",
        },
      },
    });
    expect(stateCaptureCount).toBe(2);
    expect(clickPoint).toHaveBeenCalledWith({
      app: "Safari",
      snapshotId: "snap_fresh",
      x: 200,
      y: 150,
      screenshotSource: "window",
      screenshotWidth: 400,
      screenshotHeight: 300,
      sourceBounds: { x: 40, y: 80, width: 800, height: 600 },
      windowId: 123,
      windowFrame: { x: 40, y: 80, width: 800, height: 600 },
      button: "left",
      clickCount: 1,
    });
  });

  it("requires screen recording permission for app state screenshots", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: false },
      {
        platform: "darwin",
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: "macOS Screen Recording permission is required",
      },
    });
  });

  it("rejects native app state screenshots that are not target-window captures", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          getAppState: async (app, snapshotId) => {
            return {
              app,
              snapshotId,
              elements: [],
              screenshot: "data:image/png;base64,abc123",
              screenshotMimeType: "image/png",
              screenshotSource: "screen",
              screenshotSourceName: "Built-in Display",
              screenshotWidth: 800,
              screenshotHeight: 600,
              screenshotSourceBounds: { x: 0, y: 0, width: 1440, height: 900 },
            };
          },
        }),
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message:
          "Native Computer Use app.state must return a target-window screenshot",
      },
    });
  });

  it("passes press-key combinations to the native helper", async () => {
    const cases = [
      {
        key: "Command+K",
        normalizedKey: "Command+K",
      },
      {
        key: "Control+K",
        normalizedKey: "Control+K",
      },
      {
        key: "Command+Shift+S",
        normalizedKey: "Command+Shift+S",
      },
      {
        key: "shift+semicolon",
        normalizedKey: "Shift+Semicolon",
      },
      {
        key: "Control_L+J",
        normalizedKey: "Control+J",
      },
      {
        key: "ctrl+alt+n",
        normalizedKey: "Control+Option+N",
      },
      {
        key: "Shift+;",
        normalizedKey: "Shift+Semicolon",
      },
    ];

    for (const testCase of cases) {
      const pressRequests: Array<{
        readonly app: string;
        readonly key: string;
      }> = [];
      const result = await executeComputerUseCommand(
        {
          id: "cmd_1",
          kind: "keyboard.press_key",
          payload: { app: "Safari", key: testCase.key },
        },
        { accessibility: true, screenRecording: true },
        {
          platform: "darwin",
          nativeBackend: createNativeBackend({
            pressKey: async (request) => {
              pressRequests.push(request);
              return { normalizedKey: testCase.normalizedKey };
            },
            getAppState: async (app, snapshotId) => {
              return nativeAppStateWithScreenshot(app, snapshotId);
            },
          }),
        },
      );

      expect(result).toMatchObject({
        status: "succeeded",
        result: {
          screenshot: "data:image/png;base64,abc123",
          action: { key: testCase.normalizedKey },
        },
      });
      expect(pressRequests).toStrictEqual([
        {
          app: "Safari",
          key: testCase.key,
        },
      ]);
    }
  });

  it("posts press-key combinations to the target process without app activation", async () => {
    const openApp = vi.fn<ComputerUseNativeBackend["openApp"]>();
    const pressKey = vi.fn<ComputerUseNativeBackend["pressKey"]>();
    pressKey.mockResolvedValue({
      ...nativeDispatchResult(
        "background_keyboard_event",
        "app_process",
        "background_app_shortcut",
      ),
      normalizedKey: "Command+K",
    });
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.press_key",
        payload: { app: "Safari", key: "Command+K" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          openApp,
          pressKey,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        screenshot: "data:image/png;base64,abc123",
        action: {
          key: "Command+K",
          dispatchMode: "background_keyboard_event",
          dispatchTarget: "app_process",
          inputRisk: "background_app_shortcut",
        },
      },
    });
    expect(pressKey).toHaveBeenCalledWith({
      app: "Safari",
      key: "Command+K",
    });
    expect(openApp).not.toHaveBeenCalled();
  });

  it("surfaces native press-key syntax rejections", async () => {
    const pressKey = vi.fn<ComputerUseNativeBackend["pressKey"]>();
    pressKey.mockRejectedValue(
      new ComputerUseNativeHelperError(
        "unsupported_command",
        "Unsupported key specification: Launchpad. Use xdotool-style names such as shift+semicolon, Control_L+J, ctrl+alt+n, or BackSpace.",
      ),
    );
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.press_key",
        payload: { app: "Safari", key: "Command+Launchpad" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({ pressKey }),
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message:
          "Unsupported key specification: Launchpad. Use xdotool-style names such as shift+semicolon, Control_L+J, ctrl+alt+n, or BackSpace.",
      },
    });
    expect(pressKey).toHaveBeenCalledWith({
      app: "Safari",
      key: "Command+Launchpad",
    });
  });

  it("types text through native keyboard input without requiring an editable AX focus", async () => {
    const typeText = vi.fn<ComputerUseNativeBackend["typeText"]>();
    typeText.mockResolvedValue(
      nativeDispatchResult(
        "background_keyboard_text",
        "app_process",
        "background_app_text",
      ),
    );
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.type_text",
        payload: { app: "Safari", text: "hello" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          typeText,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Safari",
          dispatchMode: "background_keyboard_text",
          dispatchTarget: "app_process",
          inputRisk: "background_app_text",
        },
      },
    });
    expect(typeText).toHaveBeenCalledWith({ app: "Safari", text: "hello" });
  });
});
