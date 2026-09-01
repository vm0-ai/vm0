import { BrowserWindow, screen } from "electron";
import { desktopRecorderUrl } from "./desktop-renderer-url";
import {
  RECORDER_BAR_SIZE,
  areaToGlobal,
  recorderBarBounds,
  type OverlayDisplayBounds,
} from "./desktop-recorder-overlay-geometry";
import type { DesktopRecorderArea } from "./desktop-recorder-types";

interface DesktopRecorderWindowsOptions {
  readonly preloadPath: string;
  readonly sessionPartition: string;
  readonly logError: (error: unknown) => void;
}

/**
 * Owns the two recorder overlay windows.
 *
 * Both exist only before a capture starts, which is why neither has to be
 * excluded from the frames: the bar is dismissed as recording begins, and the
 * area selector closes as soon as the region is drawn. Keeping them off screen
 * during capture is also why the recording controls themselves live in the menu
 * bar rather than in a floating controller.
 */
export class DesktopRecorderWindows {
  private readonly options: DesktopRecorderWindowsOptions;
  private bar: BrowserWindow | null = null;
  private areaSelector: BrowserWindow | null = null;
  /**
   * Which display the open selector covers. The overlay reports the region in
   * its own client coordinates, and the capture request is global, so the
   * display it was drawn on is what closes that gap.
   */
  private areaSelectorDisplay: OverlayDisplayBounds | null = null;
  private pendingAreaSelection:
    | ((area: DesktopRecorderArea | null) => void)
    | null = null;

  constructor(options: DesktopRecorderWindowsOptions) {
    this.options = options;
  }

  showBar(): void {
    if (this.bar && !this.bar.isDestroyed()) {
      this.bar.show();
      this.bar.focus();
      return;
    }

    const display = screen.getPrimaryDisplay();
    const window = new BrowserWindow({
      ...recorderBarBounds(display.workArea),
      ...RECORDER_BAR_SIZE,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: this.options.preloadPath,
        partition: this.options.sessionPartition,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.bar = window;
    window.on("closed", () => {
      if (this.bar === window) {
        this.bar = null;
      }
    });
    void window.loadURL(desktopRecorderUrl("bar")).catch(this.options.logError);
  }

  hideBar(): void {
    if (this.bar && !this.bar.isDestroyed()) {
      this.bar.hide();
    }
  }

  /**
   * Opens a full-screen selector over the primary display and resolves with the
   * region the user drew, or `null` when they cancelled.
   */
  async selectArea(): Promise<DesktopRecorderArea | null> {
    this.closeAreaSelector();
    const display = screen.getPrimaryDisplay();
    const window = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: this.options.preloadPath,
        partition: this.options.sessionPartition,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.areaSelector = window;
    this.areaSelectorDisplay = display.bounds;

    const selection = new Promise<DesktopRecorderArea | null>((resolve) => {
      this.pendingAreaSelection = resolve;
    });
    // A destroyed selector must settle the promise, otherwise the bar waits on
    // a window that no longer exists.
    window.on("closed", () => {
      if (this.areaSelector === window) {
        this.areaSelector = null;
      }
      this.settleAreaSelection(null);
    });

    void window
      .loadURL(desktopRecorderUrl("area"))
      .catch(this.options.logError);
    return await selection;
  }

  completeAreaSelection(area: DesktopRecorderArea | null): void {
    const display = this.areaSelectorDisplay;
    this.settleAreaSelection(
      area && display ? areaToGlobal(area, display) : null,
    );
    this.closeAreaSelector();
  }

  closeAll(): void {
    this.closeAreaSelector();
    if (this.bar && !this.bar.isDestroyed()) {
      this.bar.close();
    }
    this.bar = null;
  }

  private settleAreaSelection(area: DesktopRecorderArea | null): void {
    const resolve = this.pendingAreaSelection;
    this.pendingAreaSelection = null;
    resolve?.(area);
  }

  private closeAreaSelector(): void {
    const window = this.areaSelector;
    this.areaSelector = null;
    this.areaSelectorDisplay = null;
    if (window && !window.isDestroyed()) {
      window.close();
    }
  }
}
