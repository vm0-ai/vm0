import {
  BrowserWindow,
  session,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
} from "electron";
import {
  isDesktopAuthCompletionNavigation,
  isDesktopAuthSelectOrgNavigation,
  isDesktopAuthStartNavigation,
  isElectronNavigationAborted,
} from "./desktop-auth";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";
import { showAndFocusWindow } from "./desktop-window-lifecycle";

export interface DesktopAuthWindowRequest {
  readonly url: string;
  readonly visible: boolean;
  readonly allowInteractiveFallbacks: boolean;
  readonly signal: AbortSignal;
}

interface AuthWindowOptions {
  readonly authOrigin: string;
  readonly partition: string;
  readonly windowOptions: () => BrowserWindowConstructorOptions;
  readonly openExternal: (url: string) => void;
  readonly timeoutMs?: number;
}

interface ActiveAuthWindow {
  readonly window: BrowserWindow;
  readonly signal: AbortSignal;
  readonly deliver: (token: string) => void;
  readonly cancel: () => void;
}

/** Owns the IPC capability and the staged token until document completion. */
export class DesktopAuthWindow {
  private active: ActiveAuthWindow | null = null;
  private readonly origins: ReadonlySet<string>;

  constructor(private readonly options: AuthWindowOptions) {
    this.origins = new Set([options.authOrigin]);
  }

  completeSignIn(event: IpcMainInvokeEvent, token: string): void {
    const active = this.active;
    if (!active || active.signal.aborted || active.window.isDestroyed()) {
      throw new Error("Desktop auth operation is no longer active");
    }
    const contents = active.window.webContents;
    if (
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame
    ) {
      throw new Error("Desktop auth completion is unavailable on this page");
    }
    const url = new URL(contents.mainFrame.url);
    if (
      url.origin !== this.options.authOrigin ||
      !["/desktop-auth/token", "/desktop-auth/select-org"].includes(
        url.pathname,
      )
    ) {
      throw new Error("Desktop auth completion is unavailable on this page");
    }
    active.deliver(token);
  }

  run(request: DesktopAuthWindowRequest): Promise<string | null> {
    request.signal.throwIfAborted();
    if (!isAllowedAppNavigation(request.url, this.origins)) {
      throw new Error("Invalid Desktop auth origin");
    }
    this.active?.cancel();
    const options = this.options.windowOptions();
    const window = new BrowserWindow({
      ...options,
      webPreferences: {
        ...options.webPreferences,
        partition: this.options.partition,
      },
      show: request.visible,
      width: request.visible ? 520 : 480,
      height: 640,
      skipTaskbar: !request.visible,
    });
    this.installPolicy(window);
    return this.waitForCompletion(window, request);
  }

  async clearStorage(): Promise<void> {
    this.active?.cancel();
    await session.fromPartition(this.options.partition).clearStorageData({
      storages: [
        "cookies",
        "localstorage",
        "indexdb",
        "serviceworkers",
        "cachestorage",
      ],
    });
  }

  private installPolicy(window: BrowserWindow): void {
    const external = (url: string) => {
      const decision = decideWindowOpen(url, new Set());
      if (decision.action === "open-external") {
        this.options.openExternal(decision.url);
      }
    };
    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedAppNavigation(url, this.origins)) {
        event.preventDefault();
        external(url);
      }
    });
    window.webContents.on("will-redirect", (event, url) => {
      if (!isAllowedAppNavigation(url, this.origins)) {
        event.preventDefault();
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: "deny" };
    });
  }

  private waitForCompletion(
    window: BrowserWindow,
    request: DesktopAuthWindowRequest,
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let token: string | null = null;
      const finish = (result: string | null, error?: Error) => {
        if (settled) return;
        settled = true;
        this.active = null;
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", cancel);
        window.webContents.off("did-navigate", navigate);
        window.webContents.off("did-fail-load", failed);
        window.off("closed", closed);
        if (!window.isDestroyed()) window.close();
        if (error) reject(error);
        else resolve(result);
      };
      const cancel = () =>
        finish(null, new Error("Desktop auth operation cancelled"));
      const closed = () =>
        finish(null, new Error("Desktop auth window closed"));
      const navigate = (_event: Electron.Event, url: string) => {
        if (
          !request.allowInteractiveFallbacks &&
          (isDesktopAuthStartNavigation(url, this.origins) ||
            isDesktopAuthSelectOrgNavigation(url, this.origins))
        ) {
          finish(null);
        } else if (isDesktopAuthSelectOrgNavigation(url, this.origins)) {
          showAndFocusWindow(window);
        } else if (isDesktopAuthCompletionNavigation(url, this.origins)) {
          // App navigates only after token IPC and the handoff acknowledgement.
          // A landing page without a token is never proof of authentication.
          finish(
            token,
            token
              ? undefined
              : new Error("Desktop auth completed without a token"),
          );
        }
      };
      const failed = (
        _event: Electron.Event,
        code: number,
        _description: string,
        _url: string,
        mainFrame: boolean,
      ) => {
        if (mainFrame && code !== -3) {
          finish(null, new Error(`Desktop auth page failed: ${code}`));
        }
      };
      const timeout = setTimeout(() => {
        finish(null, new Error("Desktop auth window timed out"));
      }, this.options.timeoutMs ?? 30_000);
      this.active = {
        window,
        signal: request.signal,
        cancel,
        deliver: (value) => {
          if (settled || token !== null)
            throw new Error("Desktop auth token already delivered");
          token = value;
        },
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      window.webContents.on("did-navigate", navigate);
      window.webContents.on("did-fail-load", failed);
      window.on("closed", closed);
      void window.loadURL(request.url).catch((error: unknown) => {
        if (!isElectronNavigationAborted(error)) {
          finish(null, new Error("Desktop auth page could not load"));
        }
      });
    });
  }
}
