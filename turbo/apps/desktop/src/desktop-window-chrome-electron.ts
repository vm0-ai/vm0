import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain } from "electron";
import { DESKTOP_WINDOW_CHROME_CHANNELS } from "./desktop-window-chrome-ipc-channels";
import { applyDesktopWindowTrafficLightLayout } from "./desktop-window-chrome";

interface DesktopWindowChromeIpcOptions {
  readonly allowedAppOrigins: ReadonlySet<string>;
  readonly platform: NodeJS.Platform;
}

function isAllowedAppPage(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  try {
    return allowedAppOrigins.has(new URL(rawUrl).origin);
  } catch {
    return false;
  }
}

function assertAppPage(
  event: IpcMainInvokeEvent,
  allowedAppOrigins: ReadonlySet<string>,
): void {
  if (!isAllowedAppPage(event.senderFrame?.url ?? "", allowedAppOrigins)) {
    throw new Error("Desktop window chrome is unavailable on this page");
  }
}

function booleanArg(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Expected sidebar collapsed state");
  }
  return value;
}

export function installDesktopWindowChromeIpc(
  options: DesktopWindowChromeIpcOptions,
): void {
  ipcMain.handle(
    DESKTOP_WINDOW_CHROME_CHANNELS.setSidebarCollapsed,
    (event: IpcMainInvokeEvent, value: unknown) => {
      assertAppPage(event, options.allowedAppOrigins);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) {
        return;
      }
      applyDesktopWindowTrafficLightLayout(
        window,
        options.platform,
        booleanArg(value) ? "collapsed" : "expanded",
      );
    },
  );
}
