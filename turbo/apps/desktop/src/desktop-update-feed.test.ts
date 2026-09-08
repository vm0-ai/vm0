import { describe, expect, it } from "vitest";

import {
  desktopUpdateFeedBaseUrl,
  shouldInstallDesktopAutoUpdates,
} from "./desktop-update-feed";

describe("desktop update feed", () => {
  it("enables updates only for packaged production macOS arm64 builds", () => {
    expect(
      shouldInstallDesktopAutoUpdates({
        environment: "production",
        isPackaged: true,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(true);
    expect(
      shouldInstallDesktopAutoUpdates({
        environment: "production",
        isPackaged: true,
        platform: "darwin",
        arch: "x64",
      }),
    ).toBe(false);

    expect(
      shouldInstallDesktopAutoUpdates({
        environment: "development",
        isPackaged: true,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(false);
    expect(
      shouldInstallDesktopAutoUpdates({
        environment: "production",
        isPackaged: false,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(false);
    expect(
      shouldInstallDesktopAutoUpdates({
        environment: "production",
        isPackaged: true,
        platform: "linux",
        arch: "arm64",
      }),
    ).toBe(false);
    expect(
      shouldInstallDesktopAutoUpdates({
        environment: "production",
        isPackaged: true,
        platform: "darwin",
        arch: "ia32",
      }),
    ).toBe(false);
  });

  it("builds the static Squirrel.Mac feed base URL", () => {
    expect(
      desktopUpdateFeedBaseUrl("https://api.okou.ai", "ai-okou-desktop"),
    ).toBe(
      "https://api.okou.ai/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64",
    );
  });
});
