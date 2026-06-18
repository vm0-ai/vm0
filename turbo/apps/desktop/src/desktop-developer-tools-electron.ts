import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain } from "electron";
import type { DesktopDeveloperToolsState } from "./desktop-bridge";
import { DESKTOP_DEVELOPER_TOOLS_CHANNELS } from "./desktop-developer-tools-ipc-channels";
import { isDesktopComputerUsePageUrl } from "./computer-use-page-url";

interface DesktopDeveloperToolsIpcOptions {
  readonly rendererUrl: string;
}

interface DesktopDeveloperToolsNativeApi {
  readonly getState: () => DesktopDeveloperToolsState;
  readonly setEnabled: (enabled: boolean) => DesktopDeveloperToolsState;
}

export function notifyDesktopDeveloperToolsChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed);
    }
  }
}

export function installDesktopDeveloperToolsIpc(
  api: DesktopDeveloperToolsNativeApi,
  options: DesktopDeveloperToolsIpcOptions,
): void {
  const assertComputerUsePage = (event: IpcMainInvokeEvent): void => {
    if (
      !isDesktopComputerUsePageUrl(
        event.senderFrame?.url ?? "",
        options.rendererUrl,
      )
    ) {
      throw new Error("Desktop developer tools are unavailable on this page");
    }
  };

  ipcMain.handle(DESKTOP_DEVELOPER_TOOLS_CHANNELS.getState, (event) => {
    assertComputerUsePage(event);
    return api.getState();
  });
  ipcMain.handle(
    DESKTOP_DEVELOPER_TOOLS_CHANNELS.setEnabled,
    (event, enabled: unknown) => {
      assertComputerUsePage(event);
      if (typeof enabled !== "boolean") {
        throw new Error(
          "Desktop developer tools enabled state must be a boolean",
        );
      }
      return api.setEnabled(enabled);
    },
  );
}
