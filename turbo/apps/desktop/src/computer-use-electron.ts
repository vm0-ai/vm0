import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain, shell } from "electron";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { isDesktopComputerUsePageUrl } from "./computer-use-page-url";
import type { DesktopComputerUseState } from "./computer-use-types";

interface ComputerUseIpcOptions {
  readonly rendererUrl: string;
}

interface ComputerUseNativeApi {
  readonly getState: () => DesktopComputerUseState;
  readonly start: () => Promise<DesktopComputerUseState>;
  readonly requestAccessibilityPermission: () => DesktopComputerUseState;
}

export function notifyDesktopComputerUseChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(COMPUTER_USE_CHANNELS.changed);
    }
  }
}

export function installComputerUseIpc(
  api: ComputerUseNativeApi,
  options: ComputerUseIpcOptions,
): void {
  const assertComputerUsePage = (event: IpcMainInvokeEvent): void => {
    if (
      !isDesktopComputerUsePageUrl(
        event.senderFrame?.url ?? "",
        options.rendererUrl,
      )
    ) {
      throw new Error("Desktop Computer Use is unavailable on this page");
    }
  };

  ipcMain.handle(COMPUTER_USE_CHANNELS.getState, (event) => {
    assertComputerUsePage(event);
    return api.getState();
  });
  ipcMain.handle(COMPUTER_USE_CHANNELS.start, async (event) => {
    assertComputerUsePage(event);
    return api.start();
  });
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.requestAccessibilityPermission,
    (event) => {
      assertComputerUsePage(event);
      return api.requestAccessibilityPermission();
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.openAccessibilitySettings,
    async (event) => {
      assertComputerUsePage(event);
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.openScreenRecordingSettings,
    async (event) => {
      assertComputerUsePage(event);
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    },
  );
}
