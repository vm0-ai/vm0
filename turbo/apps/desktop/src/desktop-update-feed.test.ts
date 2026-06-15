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
  });

  it("builds the static feed base URL used by update-electron-app", () => {
    expect(desktopUpdateFeedBaseUrl("https://api.vm0.ai")).toBe(
      "https://api.vm0.ai/api/desktop/updates/stable/darwin/arm64",
    );
  });
});
