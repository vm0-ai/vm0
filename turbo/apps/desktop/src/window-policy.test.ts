import { describe, expect, it } from "vitest";
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

  it("builds the system-browser desktop auth start URL", () => {
    expect(buildDesktopAuthStartUrl(platformUrl)).toBe(
      "https://app.vm0.ai/desktop-auth/start",
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
    const pageUrl = buildSignedOutPageUrl(
      "https://app.vm0.ai/desktop-auth/start",
    );
    const html = decodeURIComponent(pageUrl.split(",")[1] ?? "");

    expect(pageUrl.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(html).toContain('href="https://app.vm0.ai/desktop-auth/start"');
    expect(html).toContain("Sign in to Zero");
  });

  it("parses a valid desktop callback code", () => {
    expect(
      parseDesktopAuthCallback(`vm0://auth/callback?code=${code}`),
    ).toStrictEqual({ code });
  });

  it("parses desktop callbacks from launch arguments", () => {
    expect(
      parseDesktopAuthCallbackArgv([
        "/Applications/Zero.app/Contents/MacOS/Zero",
        `vm0://auth/callback?code=${code}`,
      ]),
    ).toStrictEqual({ code });
    expect(
      parseDesktopAuthCallbackArgv([
        "/Applications/Zero.app/Contents/MacOS/Zero",
        "--some-flag",
      ]),
    ).toBe(null);
  });

  it("rejects unsafe desktop callbacks", () => {
    expect(parseDesktopAuthCallback("vm0://auth/callback?token=secret")).toBe(
      null,
    );
    expect(parseDesktopAuthCallback("vm0://other/callback?code=abc")).toBe(
      null,
    );
    expect(
      parseDesktopAuthCallback(
        "https://app.vm0.ai/desktop-auth/consume?code=abc",
      ),
    ).toBe(null);
  });

  it("builds the Electron web-session consume URL", () => {
    expect(buildDesktopAuthConsumeUrl(platformUrl, code)).toBe(
      `https://app.vm0.ai/desktop-auth/consume?code=${code}`,
    );
  });
});
