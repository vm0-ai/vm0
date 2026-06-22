import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopConfig } from "./config";
import { OFFLINE_COMPUTER_USE_HOST_STATE } from "./computer-use-types";
import type { ComputerUseHostRuntimeState } from "./computer-use-types";
import {
  checkForDesktopUpdates,
  installDesktopAutoUpdates,
} from "./desktop-auto-updates";

const mocks = vi.hoisted(() => {
  type AutoUpdaterListener = (...args: readonly unknown[]) => void;
  const autoUpdaterListeners = new Map<string, Set<AutoUpdaterListener>>();

  function addAutoUpdaterListener(
    eventName: string,
    listener: AutoUpdaterListener,
  ): void {
    const listeners = autoUpdaterListeners.get(eventName) ?? new Set();
    listeners.add(listener);
    autoUpdaterListeners.set(eventName, listeners);
  }

  function removeAutoUpdaterListener(
    eventName: string,
    listener: AutoUpdaterListener,
  ): void {
    autoUpdaterListeners.get(eventName)?.delete(listener);
  }

  return {
    app: { isPackaged: true },
    autoUpdater: {
      checkForUpdates: vi.fn<() => void>(),
      quitAndInstall: vi.fn(),
      once: vi.fn(addAutoUpdaterListener),
      removeListener: vi.fn(removeAutoUpdaterListener),
    },
    autoUpdaterListeners,
    dialog: {
      showMessageBox: vi.fn<() => Promise<{ response: number }>>(),
    },
    updateElectronApp: vi.fn(),
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

const originalPlatform = process.platform;
const originalArch = process.arch;

const productionConfig: DesktopConfig = {
  platformUrl: new URL("https://app.vm0.ai"),
  webUrl: new URL("https://www.vm0.ai"),
  environment: "production",
  identity: {
    displayName: "Zero Computer Use",
    bundleId: "ai.vm0.desktop",
    authProtocolName: "Zero Computer Use",
    authScheme: "vm0",
  },
  sessionPartition: "persist:vm0-desktop-production",
  allowedAppOrigins: new Set(["https://app.vm0.ai"]),
};

interface CapturedUpdateOptions {
  readonly onNotifyUser: (info: { readonly releaseName: string }) => void;
}

function stubDesktopAutoUpdatePlatform(): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
  Object.defineProperty(process, "arch", {
    configurable: true,
    value: "arm64",
  });
}

function installAndCaptureUpdateOptions(
  getComputerUseHostState: () => ComputerUseHostRuntimeState,
): {
  readonly updateOptions: CapturedUpdateOptions;
  readonly prepareForQuitAndInstall: ReturnType<typeof vi.fn>;
} {
  const prepareForQuitAndInstall = vi.fn(async () => {});

  expect(
    installDesktopAutoUpdates({
      config: productionConfig,
      apiBaseUrl: "https://api.vm0.ai",
      getComputerUseHostState,
      prepareForQuitAndInstall,
    }),
  ).toBe(true);

  expect(mocks.updateElectronApp).toHaveBeenCalledTimes(1);
  const [updateOptions] = mocks.updateElectronApp.mock.calls[0] ?? [];
  expect(updateOptions).toEqual(
    expect.objectContaining({
      notifyUser: true,
      updateInterval: "30 minutes",
      updateSource: expect.objectContaining({
        baseUrl: "https://api.vm0.ai/api/desktop/updates/stable/darwin/arm64",
      }),
    }),
  );

  return {
    updateOptions: updateOptions as CapturedUpdateOptions,
    prepareForQuitAndInstall,
  };
}

function emitAutoUpdaterEvent(
  eventName: string,
  ...args: readonly unknown[]
): void {
  const listeners = [...(mocks.autoUpdaterListeners.get(eventName) ?? [])];
  mocks.autoUpdaterListeners.delete(eventName);
  listeners.forEach((listener) => {
    listener(...args);
  });
}

async function flushDownloadedUpdateCallback(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe("desktop auto-updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.autoUpdaterListeners.clear();
    mocks.app.isPackaged = true;
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    stubDesktopAutoUpdatePlatform();
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    Object.defineProperty(process, "arch", {
      configurable: true,
      value: originalArch,
    });
  });

  it("silently restarts after a downloaded update when Computer Use is offline", async () => {
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => OFFLINE_COMPUTER_USE_HOST_STATE);

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("checks for updates on request", () => {
    expect(checkForDesktopUpdates()).toBe(true);

    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("shows when requested update checks find no update", async () => {
    expect(checkForDesktopUpdates()).toBe(true);

    emitAutoUpdaterEvent("update-not-available");
    await flushDownloadedUpdateCallback();

    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "No Updates Available",
        message: "Zero Computer Use is up to date.",
      }),
    );
  });

  it("shows when requested update checks fail", async () => {
    const error = new Error("feed unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.autoUpdater.checkForUpdates.mockImplementationOnce(() => {
      throw error;
    });

    expect(checkForDesktopUpdates()).toBe(false);
    await flushDownloadedUpdateCallback();

    expect(consoleError).toHaveBeenCalledWith(
      "Desktop update check failed",
      error,
    );
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Unable to Check for Updates",
        message: "Zero Computer Use could not check for updates.",
        detail: "feed unavailable",
      }),
    );

    consoleError.mockRestore();
  });

  it("prompts instead of silently restarting during recent command activity", async () => {
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => ({
        ...OFFLINE_COMPUTER_USE_HOST_STATE,
        lastCommandAt: new Date().toISOString(),
      }));

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });
    await flushDownloadedUpdateCallback();

    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Zero 1.2.3",
      }),
    );
    expect(prepareForQuitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("prompts when Computer Use activity inspection fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => {
        throw new Error("state unavailable");
      });

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });
    await flushDownloadedUpdateCallback();

    expect(warn).toHaveBeenCalledWith(
      "Unable to inspect Computer Use activity for update",
      expect.any(Error),
    );
    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Zero 1.2.3",
      }),
    );
    expect(prepareForQuitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
