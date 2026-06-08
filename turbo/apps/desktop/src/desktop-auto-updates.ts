import { app, autoUpdater, dialog } from "electron";
import {
  UpdateSourceType,
  updateElectronApp,
  type IUpdateInfo,
} from "update-electron-app";

import type { DesktopConfig } from "./config";
import {
  desktopUpdateFeedBaseUrl,
  shouldInstallDesktopAutoUpdates,
} from "./desktop-update-feed";

interface DesktopAutoUpdateOptions {
  readonly config: DesktopConfig;
  readonly apiBaseUrl: string;
  readonly prepareForQuitAndInstall: () => Promise<void>;
}

async function promptToRestartForUpdate(
  info: IUpdateInfo,
  prepareForQuitAndInstall: () => Promise<void>,
): Promise<void> {
  const result = await dialog.showMessageBox({
    type: "info",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Update Ready",
    message: info.releaseName,
    detail: "A new version has been downloaded. Restart Zero to install it.",
  });

  if (result.response !== 0) {
    return;
  }

  await prepareForQuitAndInstall();
  autoUpdater.quitAndInstall();
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

  const baseUrl = desktopUpdateFeedBaseUrl(options.apiBaseUrl);
  if (new URL(baseUrl).protocol !== "https:") {
    console.warn("Desktop auto-updates require an HTTPS feed URL");
    return false;
  }

  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.StaticStorage,
      baseUrl,
    },
    updateInterval: "30 minutes",
    notifyUser: true,
    onNotifyUser: (info) => {
      void promptToRestartForUpdate(
        info,
        options.prepareForQuitAndInstall,
      ).catch((error) => {
        console.error("Desktop update restart prompt failed", error);
      });
    },
  });
  return true;
}
