import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain } from "electron";
import { isDesktopComputerUsePageUrl } from "./computer-use-page-url";
import { DESKTOP_ZERO_MIGRATION_CHANNELS } from "./desktop-zero-migration-ipc-channels";
import type { DesktopZeroMigrationState } from "./desktop-zero-migration-types";

interface DesktopZeroMigrationNativeApi {
  readonly getState: () => DesktopZeroMigrationState;
  readonly remindLater: () => DesktopZeroMigrationState;
  readonly beginMigration: () => Promise<DesktopZeroMigrationState>;
  readonly resumeZero: () => Promise<DesktopZeroMigrationState>;
  readonly quitZero: () => DesktopZeroMigrationState;
}

export function notifyDesktopZeroMigrationChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_ZERO_MIGRATION_CHANNELS.changed);
    }
  }
}

export function installDesktopZeroMigrationIpc(
  api: DesktopZeroMigrationNativeApi,
  options: { readonly rendererUrl: string },
): void {
  const assertComputerUsePage = (event: IpcMainInvokeEvent): void => {
    if (
      !isDesktopComputerUsePageUrl(
        event.senderFrame?.url ?? "",
        options.rendererUrl,
      )
    ) {
      throw new Error("Zero migration is unavailable on this page");
    }
  };

  ipcMain.handle(DESKTOP_ZERO_MIGRATION_CHANNELS.getState, (event) => {
    assertComputerUsePage(event);
    return api.getState();
  });
  ipcMain.handle(DESKTOP_ZERO_MIGRATION_CHANNELS.remindLater, (event) => {
    assertComputerUsePage(event);
    return api.remindLater();
  });
  ipcMain.handle(DESKTOP_ZERO_MIGRATION_CHANNELS.beginMigration, (event) => {
    assertComputerUsePage(event);
    return api.beginMigration();
  });
  ipcMain.handle(DESKTOP_ZERO_MIGRATION_CHANNELS.resumeZero, (event) => {
    assertComputerUsePage(event);
    return api.resumeZero();
  });
  ipcMain.handle(DESKTOP_ZERO_MIGRATION_CHANNELS.quitZero, (event) => {
    assertComputerUsePage(event);
    return api.quitZero();
  });
}
