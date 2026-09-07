import { setInterval, setTimeout } from "node:timers";
import { app, autoUpdater, dialog } from "electron";

import type { DesktopConfig } from "./config";
import { shouldDeferDesktopUpdate } from "./desktop-auto-update-policy";
import type { DesktopAutoUpdatesController } from "./desktop-main-module";
import {
  desktopUpdateFeedBaseUrl,
  shouldInstallDesktopAutoUpdates,
} from "./desktop-update-feed";
import type { ComputerUseHostRuntimeState } from "./computer-use-types";

const DESKTOP_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
// Electron 42.5.1's update-race fixture waits this long after
// update-downloaded before invoking Squirrel's RACCommand again.
const DESKTOP_UPDATE_NATIVE_SETTLE_MS = 1000;

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

type DesktopUpdateCheckOutcome =
  | { readonly type: "update-not-available" }
  | { readonly type: "error"; readonly error: unknown };

interface ActiveDesktopUpdateCheck {
  manualDisplayName?: string;
  phase: "checking" | "downloading" | "settling";
}

function createDesktopUpdateCheckCoordinator(): (
  manualDisplayName?: string,
) => boolean {
  let activeCheck: ActiveDesktopUpdateCheck | undefined;

  autoUpdater.on("error", (error) => {
    if (!activeCheck || activeCheck.phase === "settling") {
      console.error("Desktop auto-updater error", error);
    }
  });

  const requestUpdateCheck = (manualDisplayName?: string): boolean => {
    if (activeCheck) {
      if (
        manualDisplayName !== undefined &&
        activeCheck.manualDisplayName === undefined
      ) {
        activeCheck.manualDisplayName = manualDisplayName;
      }
      return true;
    }

    const check: ActiveDesktopUpdateCheck = {
      manualDisplayName,
      phase: "checking",
    };
    activeCheck = check;

    const handleNoUpdate = (): void => {
      complete({ type: "update-not-available" });
    };
    const handleUpdateAvailable = (): void => {
      if (activeCheck === check && check.phase !== "settling") {
        check.phase = "downloading";
      }
    };
    const handleUpdateDownloaded = (): void => {
      if (activeCheck !== check || check.phase === "settling") {
        return;
      }

      cleanup();
      check.phase = "settling";
      setTimeout(() => {
        if (activeCheck === check) {
          activeCheck = undefined;
        }
      }, DESKTOP_UPDATE_NATIVE_SETTLE_MS);
    };
    const handleError = (error: Error): void => {
      complete({ type: "error", error });
    };

    function cleanup(): void {
      autoUpdater.removeListener("update-not-available", handleNoUpdate);
      autoUpdater.removeListener("update-available", handleUpdateAvailable);
      autoUpdater.removeListener("update-downloaded", handleUpdateDownloaded);
      autoUpdater.removeListener("error", handleError);
    }

    function complete(outcome: DesktopUpdateCheckOutcome): void {
      if (activeCheck !== check || check.phase === "settling") {
        return;
      }

      cleanup();
      activeCheck = undefined;

      if (outcome.type === "error") {
        console.error("Desktop update check failed", outcome.error);
        if (check.manualDisplayName !== undefined) {
          void notifyDesktopUpdateCheckFailed(
            check.manualDisplayName,
            outcome.error,
          ).catch((dialogError) => {
            console.error("Desktop update failure dialog failed", dialogError);
          });
        }
        return;
      }

      if (
        outcome.type === "update-not-available" &&
        check.manualDisplayName !== undefined
      ) {
        void notifyNoDesktopUpdatesFound(check.manualDisplayName).catch(
          (error) => {
            console.error("Desktop update status dialog failed", error);
          },
        );
      }
    }

    autoUpdater.once("update-not-available", handleNoUpdate);
    autoUpdater.once("update-available", handleUpdateAvailable);
    autoUpdater.once("update-downloaded", handleUpdateDownloaded);
    autoUpdater.once("error", handleError);

    try {
      autoUpdater.checkForUpdates();
      return true;
    } catch (error) {
      complete({ type: "error", error });
      return false;
    }
  };

  return requestUpdateCheck;
}

export function installDesktopAutoUpdates(
  options: DesktopAutoUpdateOptions,
): DesktopAutoUpdatesController | null {
  if (
    !shouldInstallDesktopAutoUpdates({
      environment: options.config.environment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    })
  ) {
    return null;
  }

  const baseUrl = desktopUpdateFeedBaseUrl(
    options.apiBaseUrl,
    options.config.identity.updateLine,
  );
  if (new URL(baseUrl).protocol !== "https:") {
    console.warn("Desktop auto-updates require an HTTPS feed URL");
    return null;
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
  autoUpdater.on("update-downloaded", () => {
    downloadedUpdatePending = true;
    tryInstallPendingUpdate();
  });

  autoUpdater.setFeedURL({
    url: `${baseUrl}/RELEASES.json`,
    serverType: "json",
  });

  const requestUpdateCheck = createDesktopUpdateCheckCoordinator();
  requestUpdateCheck();
  setInterval(requestUpdateCheck, DESKTOP_UPDATE_INTERVAL_MS);

  return {
    checkForUpdates: (displayName) => requestUpdateCheck(displayName),
  };
}
