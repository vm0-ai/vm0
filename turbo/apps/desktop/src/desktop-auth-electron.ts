import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain } from "electron";
import type { DesktopAuthState } from "./desktop-bridge";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import { isDesktopRendererUrl } from "./desktop-renderer-url";

interface DesktopAuthIpcOptions {
  readonly rendererUrl: string;
  readonly allowedAppOrigins: ReadonlySet<string>;
}

interface DesktopAuthNativeApi {
  readonly getState: () => Promise<DesktopAuthState> | DesktopAuthState;
  readonly openSignIn: () => void;
  readonly openOrgSelection: () => Promise<void>;
  readonly completeSignIn: (token: string) => Promise<void> | void;
}

interface DesktopAuthCompleteSignInPayload {
  readonly token: string;
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

  const assertDesktopAuthPage = (event: IpcMainInvokeEvent): void => {
    const rawUrl = event.senderFrame?.url ?? "";
    try {
      const url = new URL(rawUrl);
      if (options.allowedAppOrigins.has(url.origin)) {
        return;
      }
    } catch {
      // Fall through to the error below.
    }
    throw new Error("Desktop auth completion is unavailable on this page");
  };

  const parseCompleteSignInPayload = (
    value: unknown,
  ): DesktopAuthCompleteSignInPayload => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      throw new Error("Desktop auth completion requires a token");
    }
    return { token: value.token };
  };

  ipcMain.handle(DESKTOP_AUTH_CHANNELS.getState, (event) => {
    assertDesktopRenderer(event);
    return api.getState();
  });
  ipcMain.handle(DESKTOP_AUTH_CHANNELS.openSignIn, (event) => {
    assertDesktopRenderer(event);
    api.openSignIn();
  });
  ipcMain.handle(DESKTOP_AUTH_CHANNELS.openOrgSelection, async (event) => {
    assertDesktopRenderer(event);
    await api.openOrgSelection();
  });
  ipcMain.handle(
    DESKTOP_AUTH_CHANNELS.completeSignIn,
    async (event, payload: unknown) => {
      assertDesktopAuthPage(event);
      const parsed = parseCompleteSignInPayload(payload);
      await api.completeSignIn(parsed.token);
    },
  );
}
