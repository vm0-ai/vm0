import { BrowserWindow, screen } from "electron";
import { desktopRecorderUrl } from "./desktop-renderer-url";
import {
  RECORDER_BAR_SIZE,
  RECORDER_CONTROLLER_SIZE,
  areaToGlobal,
  recorderBarBounds,
  recorderControllerBounds,
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
  private controller: BrowserWindow | null = null;
  private pendingAreaSelection:
    | ((area: DesktopRecorderArea | null) => void)
    | null = null;

  constructor(options: DesktopRecorderWindowsOptions) {
    this.options = options;
  }

  /**
   * The display every non-window capture is aimed at.
   *
   * The overlays open on the primary display, so a region is drawn in its
   * coordinates. The helper names a display source after its CoreGraphics
   * display id, which is the id Electron reports for the same screen, so the
   * source is derived from the display the overlay used rather than picked out
   * of the helper's list, whose order is not the user's choice.
   */
  captureDisplaySourceId(): string {
    return `display:${screen.getPrimaryDisplay().id.toString()}`;
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

  /**
   * Shows the controls used while recording.
   *
   * For an area capture the controller is placed outside the captured region,
   * which is what keeps it out of the video without asking the system to
   * exclude a window. A whole-display capture has no outside, so the controller
   * is in frame; that is the known limit of this approach.
   */
  showController(captured: DesktopRecorderArea | null): void {
    this.closeController();
    const display = screen.getPrimaryDisplay();
    const position = captured
      ? recorderControllerBounds(captured, display.bounds)
      : {
          x: Math.round(
            display.workArea.x +
              (display.workArea.width - RECORDER_CONTROLLER_SIZE.width) / 2,
          ),
          y: Math.round(
            display.workArea.y +
              display.workArea.height -
              RECORDER_CONTROLLER_SIZE.height -
              24,
          ),
        };

    const window = new BrowserWindow({
      ...position,
      ...RECORDER_CONTROLLER_SIZE,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
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
    this.controller = window;
    window.on("closed", () => {
      if (this.controller === window) {
        this.controller = null;
      }
    });
    void window
      .loadURL(desktopRecorderUrl("controller"))
      .catch(this.options.logError);
  }

  hideController(): void {
    this.closeController();
  }

  private closeController(): void {
    const window = this.controller;
    this.controller = null;
    if (window && !window.isDestroyed()) {
      window.close();
    }
  }

  closeAll(): void {
    this.closeController();
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
