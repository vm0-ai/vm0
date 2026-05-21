import { describe, expect, it, vi } from "vitest";
import {
  ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
  ComputerUseSnapshotStore,
  executeComputerUseCommand,
  normalizeAccessibilitySnapshot,
  renderAccessibilityTree,
} from "./computer-use-accessibility";
import {
  buildComputerUseRuntimeBody,
  resolveComputerUseApiBaseUrl,
} from "./computer-use-host";
import { resolveDesktopConfig } from "./config";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthStartUrl,
  createDesktopAuthStartGate,
  isDesktopAuthStartNavigation,
  isDesktopSignedOutNavigation,
  parseDesktopAuthCallbackArgv,
  parseDesktopAuthCallback,
} from "./desktop-auth";
import { buildSignedOutPageUrl } from "./signed-out-page";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";

describe("resolveDesktopConfig", () => {
  it("defaults to production", () => {
    const config = resolveDesktopConfig("");

    expect(config.platformUrl.toString()).toBe("https://app.vm0.ai/");
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
    const config = resolveDesktopConfig("https://app.vm7.ai/");

    expect(config.environment).toBe("development");
    expect(config.identity).toMatchObject({
      displayName: "Zero Dev",
      bundleId: "ai.vm0.zero.desktop.dev",
      authScheme: "ai.vm0.zero.desktop.dev",
    });
    expect(config.sessionPartition).toBe("persist:vm0-desktop-development");
    expect(config.allowedAppOrigins.has("https://app.vm7.ai")).toBe(true);
    expect(config.allowedAppOrigins.has("https://www.vm7.ai")).toBe(true);
    expect(config.allowedAppOrigins.has("https://api.vm7.ai")).toBe(true);
  });

  it("derives matching origins for PR preview hostnames", () => {
    const config = resolveDesktopConfig("https://pr-123-app.vm6.ai/");

    expect(config.environment).toBe("development");
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

  it("does not derive localhost companion origins", () => {
    const config = resolveDesktopConfig("http://localhost:3002");

    expect(config.environment).toBe("development");
    expect([...config.allowedAppOrigins]).toStrictEqual([
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

describe("desktop auth", () => {
  const allowedOrigins = new Set(["https://app.vm0.ai", "https://www.vm0.ai"]);
  const platformUrl = new URL("https://app.vm0.ai");
  const code = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";

  it("builds the production system-browser desktop auth start URL", () => {
    expect(buildDesktopAuthStartUrl(platformUrl, "ai.vm0.zero.desktop")).toBe(
      "https://app.vm0.ai/desktop-auth/start?callbackScheme=ai.vm0.zero.desktop",
    );
  });

  it("builds the development system-browser desktop auth start URL", () => {
    expect(
      buildDesktopAuthStartUrl(
        new URL("https://app.vm7.ai"),
        "ai.vm0.zero.desktop.dev",
      ),
    ).toBe(
      "https://app.vm7.ai/desktop-auth/start?callbackScheme=ai.vm0.zero.desktop.dev",
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
        "https://accounts.google.com/signin",
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it("detects app sign-in navigation that should show the signed-out page", () => {
    expect(
      isDesktopSignedOutNavigation(
        "https://app.vm0.ai/sign-in",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopSignedOutNavigation(
        "https://www.vm0.ai/sign-up?redirect_url=https%3A%2F%2Fapp.vm0.ai%2F",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopSignedOutNavigation(
        "https://app.vm0.ai/desktop-auth/start",
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      isDesktopSignedOutNavigation(
        "https://accounts.google.com/signin",
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it("builds a local signed-out page with an explicit auth start link", () => {
    const authStartUrl = buildDesktopAuthStartUrl(
      platformUrl,
      "ai.vm0.zero.desktop",
    );
    const pageUrl = buildSignedOutPageUrl(authStartUrl);
    const html = decodeURIComponent(pageUrl.split(",")[1] ?? "");

    expect(pageUrl.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(html).toContain(
      'href="https://app.vm0.ai/desktop-auth/start?callbackScheme=ai.vm0.zero.desktop"',
    );
    expect(html).toContain("Sign in to Zero");
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
    expect(buildDesktopAuthConsumeUrl(platformUrl, code)).toBe(
      `https://app.vm0.ai/desktop-auth/consume?code=${code}`,
    );
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

    expect(text).toContain("snapshot_id=snap_1");
    expect(text).toContain('w0 AXWindow "Example"');
    expect(text).toContain('w0.e0 AXButton "Open" actions=AXPress');
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

    expect(text).not.toContain("w0.e0 AXGroup");
    expect(text).toContain("w0.e0.e0 AXWebArea");
    expect(text).toContain("w0.e0.e0.e0 AXGroup");
    expect(text).not.toContain("w0.e0.e0.e0.e0 AXGroup");
    expect(text).toContain(
      'w0.e0.e0.e0.e0.e0 AXButton "Send message" actions=AXPress',
    );
    expect(text).toContain(
      'w0.e0.e0.e0.e1 AXStaticText value="release-notify"',
    );
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
    expect(text).toContain('w0.e0 AXButton "Button 0"');
    expect(text).toContain('w0.e1 AXButton "Button 1"');
    expect(text).not.toContain("w0.e2");
  });

  it("returns screenshot metadata with model-readable app state", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        runJxa: async () => {
          return JSON.stringify({
            app: "Safari",
            snapshotId: "snap_1",
            elements: [
              {
                id: "w0",
                role: "AXWindow",
                name: "Example",
              },
            ],
          });
        },
        captureScreenshot: async (request) => {
          expect(request).toStrictEqual({
            app: "Safari",
            windowNames: ["Example"],
            windowBounds: [{ name: "Example" }],
          });
          return {
            dataUrl: "data:image/png;base64,abc123",
            source: "window",
            sourceName: "Example",
            width: 800,
            height: 600,
          };
        },
      },
    );

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }
    expect(result).toMatchObject({
      result: {
        app: "Safari",
        snapshotId: "snap_1",
        screenshot: "data:image/png;base64,abc123",
        screenshotMimeType: "image/png",
        screenshotSource: "window",
        screenshotSourceName: "Example",
        screenshotWidth: 800,
        screenshotHeight: 600,
      },
    });
    expect(result.result.text).toContain('w0 AXWindow "Example"');
  });

  it("requests bounded deep accessibility state from JXA", async () => {
    let capturedScript = "";
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Slack" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        runJxa: async (script) => {
          capturedScript = script;
          return JSON.stringify({
            app: "Slack",
            snapshotId: "snap_1",
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
          });
        },
        captureScreenshot: async () => {
          return {
            dataUrl: "data:image/png;base64,abc123",
            source: "window",
            sourceName: "Slack",
            width: 800,
            height: 600,
          };
        },
      },
    );

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }
    expect(capturedScript).toContain('"maxDepth":32');
    expect(capturedScript).toContain("AXManualAccessibility");
    expect(capturedScript).toContain("AXEnhancedUserInterface");
    expect(capturedScript).toContain("AXContents");
    expect(capturedScript).toContain("AXVisibleChildren");
    expect(result.result.text).toContain("Release notes posted");
    expect(result.result.text).toContain(
      'w0.e0.e0.c0.v1 AXTextArea "Message composer"',
    );
    expect(result.result.truncated).toBe(false);
  });

  it("resolves action element ids from non-uiElement child sources", async () => {
    let capturedScript = "";
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Slack", elementId: "w0.c0.v2" },
      },
      { accessibility: true, screenRecording: false },
      {
        platform: "darwin",
        runJxa: async (script) => {
          capturedScript = script;
          return "";
        },
        captureScreenshot: async () => {
          throw new Error("unexpected screenshot capture");
        },
      },
    );

    expect(result.status).toBe("succeeded");
    expect(capturedScript).toContain(
      'attributeChildren(element, "AXContents")',
    );
    expect(capturedScript).toContain(
      'attributeChildren(element, "AXVisibleChildren")',
    );
    expect(capturedScript).toContain("element.click()");
  });

  it("maps screenshot coordinate clicks through cached snapshot bounds", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const scripts: string[] = [];

    const state = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        runJxa: async (script) => {
          scripts.push(script);
          return JSON.stringify({
            app: "Safari",
            snapshotId: "snap_1",
            elements: [
              {
                id: "w0",
                role: "AXWindow",
                name: "Example",
                bounds: { x: 100, y: 200, width: 1600, height: 1200 },
              },
            ],
          });
        },
        captureScreenshot: async (request) => {
          expect(request).toStrictEqual({
            app: "Safari",
            windowNames: ["Example"],
            windowBounds: [
              {
                name: "Example",
                bounds: { x: 100, y: 200, width: 1600, height: 1200 },
              },
            ],
          });
          return {
            dataUrl: "data:image/png;base64,abc123",
            source: "window",
            sourceName: "Example",
            width: 800,
            height: 600,
            sourceBounds: { x: 100, y: 200, width: 1600, height: 1200 },
          };
        },
      },
    );
    expect(state.status).toBe("succeeded");

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
      { accessibility: true, screenRecording: false },
      {
        platform: "darwin",
        snapshotStore,
        runJxa: async (script) => {
          scripts.push(script);
          return "";
        },
        captureScreenshot: async () => {
          throw new Error("unexpected screenshot capture");
        },
      },
    );

    expect(click).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        snapshotId: "snap_1",
        x: 400,
        y: 300,
        screenX: 900,
        screenY: 800,
        button: "right",
        clickCount: 2,
        dispatchMode: "targeted_mouse_event",
        dispatchTarget: "app_process",
        inputRisk: "targeted_app_pointer",
      },
    });
    const clickScript = scripts.at(-1);
    expect(clickScript).toContain("$.CGPointMake(900, 800)");
    expect(clickScript).toContain("$.CGEventCreateMouseEvent");
    expect(clickScript).toContain("$.CGEventPostToPid(pid, event)");
    expect(clickScript).toContain("postMouseEvent(3, clickIndex)");
    expect(clickScript).not.toContain("$.CGEventPost($.kCGHIDEventTap");
    expect(clickScript).not.toContain("systemEvents.click");
  });

  it("captures fresh app state for coordinate clicks without a cached snapshot", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const scripts: string[] = [];
    let captureCount = 0;

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
        runJxa: async (script) => {
          scripts.push(script);
          if (script.includes("snapshotId")) {
            return JSON.stringify({
              app: "Safari",
              snapshotId: "snap_fresh",
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "Example",
                  bounds: { x: 40, y: 80, width: 800, height: 600 },
                },
              ],
            });
          }
          return "";
        },
        captureScreenshot: async () => {
          captureCount += 1;
          return {
            dataUrl: "data:image/png;base64,abc123",
            source: "window",
            sourceName: "Example",
            width: 400,
            height: 300,
            sourceBounds: { x: 40, y: 80, width: 800, height: 600 },
          };
        },
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        snapshotId: "snap_fresh",
        x: 200,
        y: 150,
        screenX: 440,
        screenY: 380,
        button: "left",
        clickCount: 1,
        dispatchMode: "targeted_mouse_event",
        dispatchTarget: "app_process",
        inputRisk: "targeted_app_pointer",
      },
    });
    expect(captureCount).toBe(1);
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain("$.CGPointMake(440, 380)");
    expect(scripts[1]).toContain("$.CGEventPostToPid(pid, event)");
  });

  it("requires screen recording permission for app state screenshots", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: false },
      {
        platform: "darwin",
        captureScreenshot: async () => {
          throw new Error("unexpected screenshot capture");
        },
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

  it("parses press-key combinations before posting targeted input", async () => {
    const cases = [
      {
        key: "Command+K",
        normalizedKey: "Command+K",
        keyCodeSnippet: "postKey(40, true, flags)",
        flagsSnippet: "const flags = 1048576;",
      },
      {
        key: "Control+K",
        normalizedKey: "Control+K",
        keyCodeSnippet: "postKey(40, true, flags)",
        flagsSnippet: "const flags = 262144;",
      },
      {
        key: "Command+Shift+S",
        normalizedKey: "Command+Shift+S",
        keyCodeSnippet: "postKey(1, true, flags)",
        flagsSnippet: "const flags = 1179648;",
      },
    ];

    for (const testCase of cases) {
      const scripts: string[] = [];
      const result = await executeComputerUseCommand(
        {
          id: "cmd_1",
          kind: "keyboard.press_key",
          payload: { app: "Safari", key: testCase.key },
        },
        { accessibility: true, screenRecording: true },
        {
          platform: "darwin",
          runJxa: async (script) => {
            scripts.push(script);
            return JSON.stringify({ pid: 123 });
          },
          captureScreenshot: async () => {
            throw new Error("unexpected screenshot capture");
          },
        },
      );

      expect(result).toMatchObject({
        status: "succeeded",
        result: { key: testCase.normalizedKey },
      });
      expect(scripts[0]).toContain(testCase.keyCodeSnippet);
      expect(scripts[0]).toContain(testCase.flagsSnippet);
    }
  });

  it("posts press-key combinations to the target process without app activation", async () => {
    const scripts: string[] = [];
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.press_key",
        payload: { app: "Safari", key: "Command+K" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        runJxa: async (script) => {
          scripts.push(script);
          return JSON.stringify({ pid: 123 });
        },
        captureScreenshot: async () => {
          throw new Error("unexpected screenshot capture");
        },
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        key: "Command+K",
        dispatchMode: "targeted_keyboard_event",
        dispatchTarget: "app_process",
        inputRisk: "targeted_app_shortcut",
      },
    });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("$.CGEventPostToPid(pid, event)");
    expect(scripts[0]).toContain("postKey(40, true, flags)");
    expect(scripts[0]).not.toContain("activate()");
    expect(scripts[0]).not.toContain("keystroke");
  });

  it("rejects unsupported press-key syntax before dispatching input", async () => {
    const runJxa = vi.fn<(script: string) => Promise<string>>();
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.press_key",
        payload: { app: "Safari", key: "Command+Launchpad" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        runJxa,
        captureScreenshot: async () => {
          throw new Error("unexpected screenshot capture");
        },
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message: "Unsupported key specification: Launchpad",
      },
    });
    expect(runJxa).not.toHaveBeenCalled();
  });

  it("rejects type-text when the target app has no focused editable element", async () => {
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.type_text",
        payload: { app: "Safari", text: "hello" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        runJxa: async () => {
          return JSON.stringify({
            status: "failed",
            message:
              "keyboard.type_text requires a focused editable text element in Safari",
          });
        },
        captureScreenshot: async () => {
          throw new Error("unexpected screenshot capture");
        },
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message:
          "keyboard.type_text requires a focused editable text element in Safari",
      },
    });
  });
});
