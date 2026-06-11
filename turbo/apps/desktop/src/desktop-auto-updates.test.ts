import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopConfig } from "./config";
import { IDLE_COMPUTER_USE_HOST_STATE } from "./computer-use-types";
import type { ComputerUseHostRuntimeState } from "./computer-use-types";
import { installDesktopAutoUpdates } from "./desktop-auto-updates";

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  autoUpdater: {
    quitAndInstall: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn<() => Promise<{ response: number }>>(),
  },
  updateElectronApp: vi.fn(),
}));

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

async function flushDownloadedUpdateCallback(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe("desktop auto-updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("silently restarts after a downloaded update when Computer Use is idle", async () => {
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => IDLE_COMPUTER_USE_HOST_STATE);

    updateOptions.onNotifyUser({ releaseName: "Zero 1.2.3" });

    await vi.waitFor(() => {
      expect(prepareForQuitAndInstall).toHaveBeenCalledTimes(1);
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("prompts instead of silently restarting during recent command activity", async () => {
    const { updateOptions, prepareForQuitAndInstall } =
      installAndCaptureUpdateOptions(() => ({
        ...IDLE_COMPUTER_USE_HOST_STATE,
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
