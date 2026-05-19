import { describe, expect, it } from "vitest";
import { renderAccessibilityTree } from "./computer-use-accessibility";
import {
  buildComputerUseRuntimeBody,
  resolveComputerUseApiBaseUrl,
} from "./computer-use-host";
import {
  buildComputerUseApprovalActionUrl,
  buildComputerUsePageHtml,
  COMPUTER_USE_FEATURE_SWITCH_KEY,
  parseComputerUseApprovalActionUrl,
} from "./computer-use-page";
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

describe("computer use desktop page", () => {
  it("renders feature switch and permission state", () => {
    const html = buildComputerUsePageHtml({
      featureSwitchKey: COMPUTER_USE_FEATURE_SWITCH_KEY,
      approvalActionScheme: "ai.vm0.zero.desktop",
      permissions: { accessibility: true, screenRecording: false },
      host: {
        status: "online",
        hostId: "host_123",
        lastHeartbeatAt: "2026-05-19T00:00:00.000Z",
        lastCommandAt: null,
        lastError: null,
        pendingApprovals: [
          {
            commandId: "cmd_123",
            kind: "element.click",
            app: "Safari",
            createdAt: "2026-05-19T00:01:00.000Z",
          },
        ],
        recentAuditEvents: [
          {
            commandId: "cmd_123",
            kind: "element.click",
            app: "Safari",
            event: "created",
            approvalOutcome: null,
            createdAt: "2026-05-19T00:01:00.000Z",
          },
        ],
      },
    });

    expect(html).toContain("Computer Use");
    expect(html).toContain("computerUse");
    expect(html).toContain("Accessibility");
    expect(html).toContain("Screen Recording");
    expect(html).toContain("Granted");
    expect(html).toContain("Needs setup");
    expect(html).toContain("host_123");
    expect(html).toContain("Pending approvals");
    expect(html).toContain("Recent command history");
    expect(html).toContain("cmd_123");
    expect(html).toContain(
      "ai.vm0.zero.desktop://computer-use/approval?commandId=cmd_123&amp;decision=approve",
    );
    expect(html).toContain(
      "ai.vm0.zero.desktop://computer-use/approval?commandId=cmd_123&amp;decision=deny",
    );
  });

  it("parses local Computer Use approval actions", () => {
    const url = buildComputerUseApprovalActionUrl({
      scheme: "ai.vm0.zero.desktop",
      commandId: "cmd_123",
      decision: "approve",
    });

    expect(
      parseComputerUseApprovalActionUrl(url, "ai.vm0.zero.desktop"),
    ).toStrictEqual({ commandId: "cmd_123", decision: "approve" });
    expect(
      parseComputerUseApprovalActionUrl(
        "ai.vm0.zero.desktop://computer-use/approval?commandId=cmd_123&decision=nope",
        "ai.vm0.zero.desktop",
      ),
    ).toBe(null);
    expect(
      parseComputerUseApprovalActionUrl(url, "ai.vm0.zero.desktop.dev"),
    ).toBe(null);
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
    const text = renderAccessibilityTree({
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
    });

    expect(text).toContain("snapshot_id=snap_1");
    expect(text).toContain('w0 AXWindow "Example"');
    expect(text).toContain('w0.e0 AXButton "Open" actions=AXPress');
  });
});
