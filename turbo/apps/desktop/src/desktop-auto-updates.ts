import { app, autoUpdater, dialog } from "electron";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";

import type { DesktopConfig } from "./config";
import { shouldDeferDesktopUpdate } from "./desktop-auto-update-policy";
import {
  desktopUpdateFeedBaseUrl,
  shouldInstallDesktopAutoUpdates,
} from "./desktop-update-feed";
import type { ComputerUseHostRuntimeState } from "./computer-use-types";

interface DesktopAutoUpdateOptions {
  readonly config: DesktopConfig;
  readonly apiBaseUrl: string;
  readonly getComputerUseHostState: () => ComputerUseHostRuntimeState;
  readonly prepareForQuitAndInstall: () => Promise<void>;
}

async function restartForUpdate(
  prepareForQuitAndInstall: () => Promise<void>,
): Promise<void> {
  await prepareForQuitAndInstall();
  autoUpdater.quitAndInstall();
}

async function notifyNoDesktopUpdatesFound(displayName: string): Promise<void> {
  await dialog.showMessageBox({
    type: "info",
    buttons: ["OK"],
    defaultId: 0,
    title: "No Updates Available",
    message: `${displayName} is up to date.`,
  });
}

async function notifyDesktopUpdateCheckFailed(
  displayName: string,
  error: unknown,
): Promise<void> {
  console.error("Desktop update check failed", error);
  await dialog.showMessageBox({
    type: "error",
    buttons: ["OK"],
    defaultId: 0,
    title: "Unable to Check for Updates",
    message: `${displayName} could not check for updates.`,
    detail: error instanceof Error ? error.message : undefined,
  });
}

function shouldDeferDownloadedUpdate(
  getComputerUseHostState: () => ComputerUseHostRuntimeState,
): boolean {
  try {
    return shouldDeferDesktopUpdate(getComputerUseHostState());
  } catch (error) {
    console.warn("Unable to inspect Computer Use activity for update", error);
    return true;
  }
}

export function installDesktopAutoUpdates(
  options: DesktopAutoUpdateOptions,
): boolean {
  if (
    !shouldInstallDesktopAutoUpdates({
      environment: options.config.environment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    })
  ) {
    return false;
  }

  const baseUrl = desktopUpdateFeedBaseUrl(
    options.apiBaseUrl,
    options.config.identity.product,
  );
  if (new URL(baseUrl).protocol !== "https:") {
    console.warn("Desktop auto-updates require an HTTPS feed URL");
    return false;
  }

  let downloadedUpdatePending = false;
  let updateInstallationInProgress = false;

  const installPendingUpdateWhenInactive = async (): Promise<void> => {
    if (
      !downloadedUpdatePending ||
      updateInstallationInProgress ||
      shouldDeferDownloadedUpdate(options.getComputerUseHostState)
    ) {
      return;
    }

    updateInstallationInProgress = true;
    try {
      await restartForUpdate(options.prepareForQuitAndInstall);
      downloadedUpdatePending = false;
    } finally {
      updateInstallationInProgress = false;
    }
  };

  const tryInstallPendingUpdate = (): void => {
    void installPendingUpdateWhenInactive().catch((error) => {
      console.error("Desktop update install failed", error);
    });
  };

  autoUpdater.on("checking-for-update", tryInstallPendingUpdate);

  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.StaticStorage,
      baseUrl,
    },
    updateInterval: "30 minutes",
    notifyUser: true,
    onNotifyUser: () => {
      downloadedUpdatePending = true;
      tryInstallPendingUpdate();
    },
  });
  return true;
}

export function checkForDesktopUpdates(displayName: string): boolean {
  const handleNoUpdate = (): void => {
    cleanup();
    void notifyNoDesktopUpdatesFound(displayName).catch((error) => {
      console.error("Desktop update status dialog failed", error);
    });
  };
  const handleUpdateAvailable = (): void => {
    cleanup();
  };
  const handleError = (error: Error): void => {
    cleanup();
    void notifyDesktopUpdateCheckFailed(displayName, error).catch(
      (dialogError) => {
        console.error("Desktop update failure dialog failed", dialogError);
      },
    );
  };

  function cleanup(): void {
    autoUpdater.removeListener("update-not-available", handleNoUpdate);
    autoUpdater.removeListener("update-available", handleUpdateAvailable);
    autoUpdater.removeListener("error", handleError);
  }

  autoUpdater.once("update-not-available", handleNoUpdate);
  autoUpdater.once("update-available", handleUpdateAvailable);
  autoUpdater.once("error", handleError);

  try {
    autoUpdater.checkForUpdates();
    return true;
  } catch (error) {
    cleanup();
    void notifyDesktopUpdateCheckFailed(displayName, error).catch(
      (dialogError) => {
        console.error("Desktop update failure dialog failed", dialogError);
      },
    );
    return false;
  }
}
