import { BrowserWindow, screen } from "electron";
import { desktopRecorderUrl } from "./desktop-renderer-url";
import {
  RECORDER_CONTROLLER_SIZE,
  RECORDER_WINDOW_PICKER_SIZE,
  bottomCentredBounds,
  centredBounds,
  recorderBarBounds,
  recorderControllerBounds,
} from "./desktop-recorder-overlay-geometry";
import type {
  DesktopRecorderArea,
  DesktopRecorderWindowChoice,
} from "./desktop-recorder-types";

interface DesktopRecorderWindowsOptions {
  readonly preloadPath: string;
  readonly sessionPartition: string;
  readonly logError: (error: unknown) => void;
}

/**
 * Owns the recorder's overlay windows: the bar, one area selector per display,
 * the window picker, and the controls shown while recording.
 *
 * Only the controller is on screen during a capture, and for an area capture it
 * is placed outside the recorded region, so none of these windows has to be
 * excluded from the frames.
 */
export class DesktopRecorderWindows {
  private readonly options: DesktopRecorderWindowsOptions;
  private bar: BrowserWindow | null = null;
  /** One selector per display, so a region can be drawn on any screen. */
  private areaSelectors: BrowserWindow[] = [];
  private windowPicker: BrowserWindow | null = null;
  private controller: BrowserWindow | null = null;
  private pendingWindowChoice:
    | ((choice: DesktopRecorderWindowChoice | null) => void)
    | null = null;

  constructor(options: DesktopRecorderWindowsOptions) {
    this.options = options;
  }

  /**
   * The display a whole-screen capture is aimed at.
   *
   * The helper names a display source after its CoreGraphics display id, which
   * is the id Electron reports for the same screen, so the source is derived
   * from the display the bar is on rather than picked out of the helper's list,
   * whose order is not the user's choice.
   */
  displaySourceId(displayId: number): string {
    return `display:${displayId.toString()}`;
  }

  /** The screen the bar is on, which is the one a display capture records. */
  barDisplayId(): number {
    const bar = this.bar;
    if (!bar || bar.isDestroyed()) {
      return screen.getPrimaryDisplay().id;
    }
    return screen.getDisplayMatching(bar.getBounds()).id;
  }

  /**
   * Opens the bar.
   *
   * Always a fresh window: the bar carries the choices and the busy state of
   * one recording, and reusing the old one showed the previous session's
   * selection and a Start button still reading "Starting…".
   */
  showBar(): void {
    this.closeBar();
    const display = screen.getPrimaryDisplay();
    const window = this.createOverlay({
      ...recorderBarBounds(display.workArea),
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
    });
    this.bar = window;
    window.on("closed", () => {
      if (this.bar === window) {
        this.bar = null;
      }
    });
    void window.loadURL(desktopRecorderUrl("bar")).catch(this.options.logError);
  }

  hideBar(): void {
    this.closeBar();
  }

  /**
   * Covers every display with a selector, so a region can be drawn on any
   * screen rather than only the one the bar happens to be on.
   *
   * Nothing is returned: the selection ends in the overlay, which reports the
   * region and the display it was drawn on through `completeAreaSelection`.
   */
  openAreaSelectors(): void {
    this.closeAreaSelectors();
    for (const display of screen.getAllDisplays()) {
      const window = this.createOverlay({
        ...display.bounds,
        movable: false,
        enableLargerThanScreen: true,
      });
      this.areaSelectors.push(window);
      window.on("closed", () => {
        this.areaSelectors = this.areaSelectors.filter((open) => {
          return open !== window;
        });
      });
      void window
        .loadURL(desktopRecorderUrl("area", { display: display.id.toString() }))
        .catch(this.options.logError);
    }
  }

  closeAreaSelectors(): void {
    const open = this.areaSelectors;
    this.areaSelectors = [];
    for (const window of open) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
  }

  /** Display bounds for a selector, so its region can be made global. */
  displayBounds(displayId: number): {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null {
    const display = screen.getAllDisplays().find((candidate) => {
      return candidate.id === displayId;
    });
    return display ? display.bounds : null;
  }

  /**
   * Opens the window picker and resolves with the window the user chose, or
   * `null` when they closed it.
   *
   * The picker is its own window because the bar is sized to its row of
   * controls; a grid of previews drawn inside it would be clipped away.
   */
  async selectWindow(): Promise<DesktopRecorderWindowChoice | null> {
    this.closeWindowPicker();
    const display = screen.getPrimaryDisplay();
    const window = this.createOverlay({
      ...centredBounds(display.workArea, RECORDER_WINDOW_PICKER_SIZE),
      movable: true,
    });
    this.windowPicker = window;

    const chosen = new Promise<DesktopRecorderWindowChoice | null>(
      (resolve) => {
        this.pendingWindowChoice = resolve;
      },
    );
    // A destroyed picker must settle the promise, otherwise the bar waits on a
    // window that no longer exists.
    window.on("closed", () => {
      if (this.windowPicker === window) {
        this.windowPicker = null;
      }
      this.settleWindowChoice(null);
    });

    void window
      .loadURL(desktopRecorderUrl("windows"))
      .catch(this.options.logError);
    return await chosen;
  }

  completeWindowSelection(choice: DesktopRecorderWindowChoice | null): void {
    this.settleWindowChoice(choice);
    this.closeWindowPicker();
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
    // The controls belong on the screen being recorded, not on whichever screen
    // happens to be primary.
    const display = captured
      ? screen.getDisplayMatching(captured)
      : screen.getPrimaryDisplay();
    const position = captured
      ? recorderControllerBounds(captured, display.bounds)
      : bottomCentredBounds(display.workArea, RECORDER_CONTROLLER_SIZE, 24);

    const window = this.createOverlay({
      x: position.x,
      y: position.y,
      ...RECORDER_CONTROLLER_SIZE,
      movable: true,
    });
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

  closeAll(): void {
    this.closeController();
    this.closeAreaSelectors();
    this.closeWindowPicker();
    this.closeBar();
  }

  private createOverlay(
    bounds: Electron.BrowserWindowConstructorOptions,
  ): BrowserWindow {
    const window = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      // Without this the window paints its own opaque backing wherever the
      // page does not, which is how a grey strip appeared under the bar.
      backgroundColor: "#00000000",
      resizable: false,
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
    return window;
  }

  private settleWindowChoice(choice: DesktopRecorderWindowChoice | null): void {
    const resolve = this.pendingWindowChoice;
    this.pendingWindowChoice = null;
    resolve?.(choice);
  }

  private closeBar(): void {
    const window = this.bar;
    this.bar = null;
    if (window && !window.isDestroyed()) {
      window.close();
    }
  }

  private closeWindowPicker(): void {
    const window = this.windowPicker;
    this.windowPicker = null;
    if (window && !window.isDestroyed()) {
      window.close();
    }
  }

  private closeController(): void {
    const window = this.controller;
    this.controller = null;
    if (window && !window.isDestroyed()) {
      window.close();
    }
  }
}
