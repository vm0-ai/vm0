import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import type { DesktopAuthState } from "./desktop-bridge";
import type { DesktopComputerUseState } from "./computer-use-types";
import {
  buildDesktopTrayMenuItems,
  type DesktopTrayMenuActions,
  type DesktopTrayMenuItem,
} from "./desktop-tray-menu";

interface DesktopTrayControllerOptions {
  readonly displayName: string;
  readonly iconPath: string;
  readonly getComputerUseState: () => DesktopComputerUseState;
  readonly getAuthState: () => Promise<DesktopAuthState>;
  readonly showMainWindow: () => Promise<void>;
  readonly startComputerUse: () => Promise<void>;
  readonly refreshStatus: () => Promise<void>;
  readonly openSignIn: () => void;
  readonly switchWorkspace: () => Promise<void>;
  readonly openAccessibilitySettings: () => void;
  readonly openScreenRecordingSettings: () => void;
  readonly quit: () => void;
}

function desktopTrayIcon(iconPath: string): NativeImage {
  const image = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }
  return image;
}

function electronMenuItem(
  item: DesktopTrayMenuItem,
): MenuItemConstructorOptions {
  const template: MenuItemConstructorOptions = {};
  if (item.type) {
    template.type = item.type;
  }
  if (item.label) {
    template.label = item.label;
  }
  if (item.enabled !== undefined) {
    template.enabled = item.enabled;
  }
  if (item.click) {
    template.click = item.click;
  }
  if (item.submenu) {
    template.submenu = item.submenu.map(electronMenuItem);
  }
  return template;
}

function electronMenuTemplate(
  items: readonly DesktopTrayMenuItem[],
): MenuItemConstructorOptions[] {
  return items.map(electronMenuItem);
}

export class DesktopTrayController {
  private readonly options: DesktopTrayControllerOptions;
  private tray: Tray | null = null;
  private authState: DesktopAuthState | null = null;
  private authError: string | null = null;
  private authRefreshVersion = 0;
  private menuSignature: string | null = null;

  constructor(options: DesktopTrayControllerOptions) {
    this.options = options;
  }

  install(): void {
    if (this.tray) {
      return;
    }

    this.tray = new Tray(desktopTrayIcon(this.options.iconPath));
    this.tray.setToolTip(this.options.displayName);
    this.refresh();
    this.refreshAuth();
  }

  refresh(): void {
    const tray = this.tray;
    if (!tray) {
      return;
    }

    const actions = this.menuActions();
    const items = buildDesktopTrayMenuItems(
      {
        computerUse: this.options.getComputerUseState(),
        auth: this.authState,
        authError: this.authError,
      },
      actions,
    );
    const signature = JSON.stringify(items, (_key, value: unknown) => {
      return typeof value === "function" ? "[function]" : value;
    });
    if (signature === this.menuSignature) {
      return;
    }
    this.menuSignature = signature;
    tray.setContextMenu(Menu.buildFromTemplate(electronMenuTemplate(items)));
  }

  refreshAuth(): void {
    const version = this.authRefreshVersion + 1;
    this.authRefreshVersion = version;
    void this.options
      .getAuthState()
      .then((authState) => {
        if (version !== this.authRefreshVersion) {
          return;
        }
        this.authState = authState;
        this.authError = null;
        this.refresh();
      })
      .catch((error: unknown) => {
        if (version !== this.authRefreshVersion) {
          return;
        }
        this.authError = error instanceof Error ? error.message : String(error);
        this.authState = null;
        this.refresh();
      });
  }

  private menuActions(): DesktopTrayMenuActions {
    return {
      showMainWindow: this.runAction("show main window", () => {
        return this.options.showMainWindow();
      }),
      startComputerUse: this.runAction("start Computer Use", () => {
        return this.options.startComputerUse();
      }),
      refreshStatus: this.runAction(
        "refresh status",
        async () => {
          await this.options.refreshStatus();
        },
        { refreshAuth: true },
      ),
      openSignIn: this.runAction(
        "open sign in",
        () => {
          this.options.openSignIn();
        },
        { refreshAuth: true },
      ),
      switchWorkspace: this.runAction(
        "switch workspace",
        () => {
          return this.options.switchWorkspace();
        },
        { refreshAuth: true },
      ),
      openAccessibilitySettings: this.runAction(
        "open Accessibility Settings",
        () => {
          this.options.openAccessibilitySettings();
        },
      ),
      openScreenRecordingSettings: this.runAction(
        "open Screen Recording Settings",
        () => {
          this.options.openScreenRecordingSettings();
        },
      ),
      quit: () => {
        this.options.quit();
      },
    };
  }

  private runAction(
    label: string,
    action: () => Promise<void> | void,
    options: { readonly refreshAuth?: boolean } = {},
  ): () => void {
    return () => {
      void Promise.resolve()
        .then(action)
        .catch((error: unknown) => {
          console.error("Desktop tray action failed", label, error);
        })
        .finally(() => {
          if (options.refreshAuth) {
            this.refreshAuth();
            return;
          }
          this.refresh();
        });
    };
  }
}

export function installDesktopTray(
  options: DesktopTrayControllerOptions,
): DesktopTrayController {
  const controller = new DesktopTrayController(options);
  controller.install();
  return controller;
}
