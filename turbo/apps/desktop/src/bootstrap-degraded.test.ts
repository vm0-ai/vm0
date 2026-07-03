import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopConfig } from "./config";

const mocks = vi.hoisted(() => {
  return {
    app: {
      isPackaged: true,
      requestSingleInstanceLock: vi.fn<() => boolean>(() => true),
      quit: vi.fn(),
      whenReady: vi.fn<() => Promise<void>>(() => Promise.resolve()),
      getPath: vi.fn<(name: string) => string>(),
    },
    autoUpdater: {
      quitAndInstall: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    },
    dialog: {
      showMessageBox: vi.fn<
        (options: { detail?: string }) => Promise<{ response: number }>
      >(async () => ({ response: 0 })),
    },
    updateElectronApp:
      vi.fn<
        (options: {
          updateSource: { baseUrl: string };
          onNotifyUser: (info: { releaseName: string }) => void;
        }) => void
      >(),
    sentryInit: vi.fn(),
    sentryCaptureException: vi.fn<(error: unknown) => string>(() => "event"),
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  autoUpdater: mocks.autoUpdater,
  dialog: mocks.dialog,
}));

vi.mock("update-electron-app", () => ({
  UpdateSourceType: {
    StaticStorage: "staticStorage",
  },
  updateElectronApp: mocks.updateElectronApp,
}));

vi.mock("@sentry/electron/main", () => ({
  init: mocks.sentryInit,
  captureException: mocks.sentryCaptureException,
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function productionConfig(): DesktopConfig {
  return {
    platformUrl: new URL("https://app.vm0.ai"),
    webUrl: new URL("https://app.vm0.ai"),
    environment: "production",
    identity: {
      displayName: "Zero Computer Use",
      bundleId: "ai.vm0.desktop",
      authProtocolName: "Zero Desktop",
      authScheme: "vm0-desktop",
    },
    sessionPartition: "persist:desktop",
    allowedAppOrigins: new Set(["https://app.vm0.ai"]),
  };
}

async function enterDegradedMode(error: unknown): Promise<void> {
  const { enterDegradedDesktopMode } = await import("./bootstrap-degraded");
  enterDegradedDesktopMode({
    config: productionConfig(),
    apiBaseUrl: "https://api.vm0.ai",
    error,
  });
  await vi.waitFor(() => {
    expect(mocks.dialog.showMessageBox).toHaveBeenCalled();
  });
}

beforeEach(() => {
  vi.resetModules();
  setPlatform("darwin");
  mocks.app.isPackaged = true;
  mocks.app.requestSingleInstanceLock.mockReturnValue(true);
  mocks.app.getPath.mockReturnValue(mkdtempSync(join(tmpdir(), "bootstrap-")));
  delete process.env.SENTRY_DSN_DESKTOP;
  return () => {
    setPlatform(originalPlatform);
  };
});

describe("enterDegradedDesktopMode", () => {
  it("quits without installing updates when another instance holds the lock", async () => {
    mocks.app.requestSingleInstanceLock.mockReturnValue(false);

    const { enterDegradedDesktopMode } = await import("./bootstrap-degraded");
    enterDegradedDesktopMode({
      config: productionConfig(),
      apiBaseUrl: "https://api.vm0.ai",
      error: new Error("boom"),
    });

    expect(mocks.app.quit).toHaveBeenCalled();
    expect(mocks.updateElectronApp).not.toHaveBeenCalled();
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("installs auto-updates and tells the user an update will self-heal", async () => {
    await enterDegradedMode(new Error("boom"));

    expect(mocks.updateElectronApp).toHaveBeenCalledWith(
      expect.objectContaining({
        updateSource: expect.objectContaining({
          baseUrl:
            "https://api.vm0.ai/api/desktop/updates/stable/darwin/" +
            process.arch,
        }),
      }),
    );
    const dialogOptions = mocks.dialog.showMessageBox.mock.calls[0]?.[0];
    expect(dialogOptions?.detail).toContain("installed automatically");
  });

  it("installs a downloaded update without prompting the user", async () => {
    await enterDegradedMode(new Error("boom"));

    const updateOptions = mocks.updateElectronApp.mock.calls[0]?.[0];
    updateOptions?.onNotifyUser({ releaseName: "v0.22.6" });

    await vi.waitFor(() => {
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalled();
    });
    // Only the startup-error dialog is shown; no restart confirmation.
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("tells the user to reinstall when auto-updates cannot be installed", async () => {
    mocks.app.isPackaged = false;

    await enterDegradedMode(new Error("boom"));

    expect(mocks.updateElectronApp).not.toHaveBeenCalled();
    const dialogOptions = mocks.dialog.showMessageBox.mock.calls[0]?.[0];
    expect(dialogOptions?.detail).toContain("reinstall");
  });

  it("reports the load failure to Sentry when a DSN is configured", async () => {
    process.env.SENTRY_DSN_DESKTOP = "https://key@sentry.example/1";
    const error = new Error("boom");

    await enterDegradedMode(error);

    expect(mocks.sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: "https://key@sentry.example/1" }),
    );
    expect(mocks.sentryCaptureException).toHaveBeenCalledWith(error);
  });

  it("writes a local failure log when no Sentry DSN is configured", async () => {
    const logsDir = mkdtempSync(join(tmpdir(), "bootstrap-logs-"));
    mocks.app.getPath.mockReturnValue(logsDir);

    await enterDegradedMode(new Error("boom"));

    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(readdirSync(logsDir)).toEqual(["desktop-bootstrap-failure.log"]);
    expect(
      readFileSync(join(logsDir, "desktop-bootstrap-failure.log"), "utf8"),
    ).toContain("boom");
  });
});
