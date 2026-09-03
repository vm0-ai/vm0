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
  const autoUpdaterOnceListeners = new Map<string, Set<AutoUpdaterListener>>();

  function addAutoUpdaterListener(
    eventName: string,
    listener: AutoUpdaterListener,
  ): void {
    const listeners = autoUpdaterListeners.get(eventName) ?? new Set();
    listeners.add(listener);
    autoUpdaterListeners.set(eventName, listeners);
  }

  function addAutoUpdaterOnceListener(
    eventName: string,
    listener: AutoUpdaterListener,
  ): void {
    const listeners = autoUpdaterOnceListeners.get(eventName) ?? new Set();
    listeners.add(listener);
    autoUpdaterOnceListeners.set(eventName, listeners);
  }

  function removeAutoUpdaterListener(
    eventName: string,
    listener: AutoUpdaterListener,
  ): void {
    autoUpdaterListeners.get(eventName)?.delete(listener);
    autoUpdaterOnceListeners.get(eventName)?.delete(listener);
  }

  return {
    app: { isPackaged: true },
    autoUpdater: {
      checkForUpdates: vi.fn<() => void>(),
      quitAndInstall: vi.fn(),
      on: vi.fn(addAutoUpdaterListener),
      once: vi.fn(addAutoUpdaterOnceListener),
      removeListener: vi.fn(removeAutoUpdaterListener),
    },
    autoUpdaterListeners,
    autoUpdaterOnceListeners,
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
    product: "zero",
    brandName: "Zero",
    displayName: "Zero Computer Use",
    userDataDirectoryName: "Zero Computer Use",
    updateLine: "zero",
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

function stubDesktopAutoUpdatePlatform(
  arch: NodeJS.Architecture = "arm64",
): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
  Object.defineProperty(process, "arch", {
    configurable: true,
    value: arch,
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
        baseUrl:
          "https://api.vm0.ai/api/desktop/updates/zero/stable/darwin/arm64",
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
  const onceListeners = [
    ...(mocks.autoUpdaterOnceListeners.get(eventName) ?? []),
  ];
  mocks.autoUpdaterOnceListeners.delete(eventName);
  [...listeners, ...onceListeners].forEach((listener) => {
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
    mocks.autoUpdaterOnceListeners.clear();
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

  it("does not install auto-updates on Intel Macs", () => {
    stubDesktopAutoUpdatePlatform("x64");

    expect(
      installDesktopAutoUpdates({
        config: productionConfig,
        apiBaseUrl: "https://api.vm0.ai",
        getComputerUseHostState: () => OFFLINE_COMPUTER_USE_HOST_STATE,
        prepareForQuitAndInstall: vi.fn(async () => {}),
      }),
    ).toBe(false);
    expect(mocks.updateElectronApp).not.toHaveBeenCalled();
  });

  it("selects the isolated Okou update feed for an Okou identity", () => {
    const okouConfig: DesktopConfig = {
      ...productionConfig,
      identity: {
        product: "okou",
        brandName: "Okou",
        displayName: "Okou",
        userDataDirectoryName: "Okou",
        updateLine: "ai-okou-desktop",
        bundleId: "ai.okou.desktop",
        authProtocolName: "Okou Desktop Auth",
        authScheme: "ai.okou.desktop",
      },
    };

    expect(
      installDesktopAutoUpdates({
        config: okouConfig,
        apiBaseUrl: "https://api.okou.ai",
        getComputerUseHostState: () => OFFLINE_COMPUTER_USE_HOST_STATE,
        prepareForQuitAndInstall: vi.fn(async () => {}),
      }),
    ).toBe(true);
    expect(mocks.updateElectronApp).toHaveBeenCalledWith(
      expect.objectContaining({
        updateSource: expect.objectContaining({
          baseUrl:
            "https://api.okou.ai/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64",
        }),
      }),
    );
  });

  it("checks for updates on request", () => {
    expect(checkForDesktopUpdates("Zero Computer Use")).toBe(true);

    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("shows when requested update checks find no update", async () => {
    expect(checkForDesktopUpdates("Zero Computer Use")).toBe(true);

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

    expect(checkForDesktopUpdates("Zero Computer Use")).toBe(false);
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

  it("defers without prompting during recent command activity", async () => {
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => ({
        ...OFFLINE_COMPUTER_USE_HOST_STATE,
        lastCommandAt: new Date().toISOString(),
      }));

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });
    await flushDownloadedUpdateCallback();

    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(prepareForQuitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("installs a deferred update on the next check after activity stops", async () => {
    let hostState: ComputerUseHostRuntimeState = {
      ...OFFLINE_COMPUTER_USE_HOST_STATE,
      lastCommandAt: new Date().toISOString(),
    };
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => hostState);

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });
    await flushDownloadedUpdateCallback();

    hostState = OFFLINE_COMPUTER_USE_HOST_STATE;
    emitAutoUpdaterEvent("checking-for-update");

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("keeps a downloaded update pending across active checks", async () => {
    let hostState: ComputerUseHostRuntimeState = {
      ...OFFLINE_COMPUTER_USE_HOST_STATE,
      lastCommandAt: new Date().toISOString(),
    };
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => hostState);

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });
    emitAutoUpdaterEvent("checking-for-update");
    emitAutoUpdaterEvent("checking-for-update");
    await flushDownloadedUpdateCallback();

    expect(prepareForQuitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    hostState = OFFLINE_COMPUTER_USE_HOST_STATE;
    emitAutoUpdaterEvent("checking-for-update");

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  it("defers when Computer Use activity inspection fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let inspectionFails = true;
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => {
        if (inspectionFails) {
          throw new Error("state unavailable");
        }
        return OFFLINE_COMPUTER_USE_HOST_STATE;
      });

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });
    await flushDownloadedUpdateCallback();

    expect(warn).toHaveBeenCalledWith(
      "Unable to inspect Computer Use activity for update",
      expect.any(Error),
    );
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(prepareForQuitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    inspectionFails = false;
    emitAutoUpdaterEvent("checking-for-update");

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    warn.mockRestore();
  });

  it("starts only one install while an update restart is in progress", async () => {
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => OFFLINE_COMPUTER_USE_HOST_STATE);
    let finishPreparation: (() => void) | undefined;
    prepareForQuitAndInstall.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });
    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
    });

    emitAutoUpdaterEvent("checking-for-update");
    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });
    await flushDownloadedUpdateCallback();

    expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    finishPreparation?.();
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    emitAutoUpdaterEvent("checking-for-update");
    await flushDownloadedUpdateCallback();
    expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
