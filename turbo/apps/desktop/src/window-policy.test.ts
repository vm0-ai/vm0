import { describe, expect, it } from "vitest";
import { resolveDesktopConfig } from "./config";
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
      isAllowedAppNavigation("https://www.vm0.ai/sign-in", allowedOrigins),
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

  it("allows Clerk development frontend API navigation inside Electron", () => {
    expect(
      isAllowedAppNavigation(
        "https://mock-instance.clerk.accounts.dev/v1/client",
        allowedOrigins,
      ),
    ).toBe(true);
  });

  it("opens same-site Clerk frontend API windows inside Electron", () => {
    expect(
      decideWindowOpen(
        "https://clerk.vm0.ai/v1/oauth_callback",
        allowedOrigins,
      ),
    ).toStrictEqual({ action: "allow-in-app" });
  });

  it("opens Google OAuth windows inside Electron", () => {
    expect(
      decideWindowOpen(
        "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fmock-instance.clerk.accounts.dev%2Fv1%2Foauth_callback&state=abc",
        allowedOrigins,
      ),
    ).toStrictEqual({ action: "allow-in-app" });
  });

  it("opens GitHub OAuth windows inside Electron", () => {
    expect(
      decideWindowOpen(
        "https://github.com/login/oauth/authorize?client_id=clerk&redirect_uri=https%3A%2F%2Fclerk.vm0.ai%2Fv1%2Foauth_callback&state=abc",
        allowedOrigins,
      ),
    ).toStrictEqual({ action: "allow-in-app" });
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
