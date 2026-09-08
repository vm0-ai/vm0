import { Menu, type MenuItemConstructorOptions } from "electron";
import type { DeveloperToolsController } from "./desktop-developer-tools-controller";
import { desktopDeveloperToolsMenu } from "./desktop-developer-tools-menu";

interface DesktopApplicationMenuOptions {
  readonly displayName: string;
  readonly developerTools: DeveloperToolsController;
  readonly updatesEnabled: () => boolean;
  readonly checkForUpdates: () => void;
  readonly quit: () => void;
}

export class DesktopApplicationMenu {
  private pending: NodeJS.Immediate | null = null;
  private requested = false;
  private disposed = false;
  private signature: string | null = null;

  constructor(private readonly options: DesktopApplicationMenuOptions) {}

  refresh(): void {
    if (this.disposed) return;
    this.requested = true;
    if (this.pending) return;
    // Leave the active native menu/window callback before rebuilding. Keep
    // ownership through installation so a native read-back cannot nest it.
    this.pending = setImmediate(() => {
      this.requested = false;
      try {
        this.install();
      } finally {
        this.pending = null;
        if (this.requested) this.refresh();
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.requested = false;
    if (this.pending) clearImmediate(this.pending);
    this.pending = null;
  }

  private install(): void {
    const updatesEnabled = this.options.updatesEnabled();
    const developer = this.options.developerTools.getState();
    const signature = JSON.stringify({ updatesEnabled, ...developer });
    if (signature === this.signature) return;
    const appSubmenu: MenuItemConstructorOptions[] = [
      { role: "about" },
      {
        label: "Check for Updates...",
        enabled: updatesEnabled,
        click: this.options.checkForUpdates,
      },
      { type: "separator" },
    ];
    appSubmenu.push(...desktopDeveloperToolsMenu(this.options.developerTools));
    appSubmenu.push({
      label: `Quit ${this.options.displayName}`,
      accelerator: "CommandOrControl+Q",
      click: this.options.quit,
    });

    const menu = Menu.buildFromTemplate([
      {
        label: this.options.displayName,
        submenu: appSubmenu,
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "close" }],
      },
    ]);
    if (this.disposed) return;
    Menu.setApplicationMenu(menu);
    this.signature = signature;
  }
}
