import { describe, expect, it } from "vitest";
import {
  ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
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
});
