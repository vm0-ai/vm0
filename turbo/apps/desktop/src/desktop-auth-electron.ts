import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain } from "electron";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import { isDesktopRendererUrl } from "./desktop-renderer-url";

interface DesktopAuthIpcOptions {
  readonly rendererUrl: string;
}

interface DesktopAuthNativeApi {
  readonly openSignIn: () => void;
}

export function notifyDesktopAuthChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_AUTH_CHANNELS.changed);
    }
  }
}

export function installDesktopAuthIpc(
  api: DesktopAuthNativeApi,
  options: DesktopAuthIpcOptions,
): void {
  const assertDesktopRenderer = (event: IpcMainInvokeEvent): void => {
    if (
      !isDesktopRendererUrl(event.senderFrame?.url ?? "", options.rendererUrl)
    ) {
      throw new Error("Desktop auth is unavailable on this page");
    }
  };

  ipcMain.handle(DESKTOP_AUTH_CHANNELS.openSignIn, (event) => {
    assertDesktopRenderer(event);
    api.openSignIn();
  });
}
