import { BrowserWindow, screen, type Display, type Rectangle } from "electron";

import type {
  ComputerUseActionVisualizer,
  ComputerUseActionVisualizerPointerEvent,
} from "./computer-use-accessibility";

interface OverlayPointerEvent {
  readonly type: "pointer";
  readonly x: number;
  readonly y: number;
  readonly phase: "target" | "click";
  readonly hideDelayMs: number;
}

const POINTER_IDLE_HIDE_DELAY_MS = 30_000;

const OVERLAY_HTML = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
        pointer-events: none;
      }

      .pointer {
        position: absolute;
        top: 0;
        left: 0;
        width: 18px;
        height: 20px;
        opacity: 0;
        transform: translate(0, 0) scale(0.96);
        transform-origin: 0 0;
        transition:
          opacity 120ms ease-out,
          transform 170ms cubic-bezier(0.2, 0.85, 0.25, 1);
        will-change: transform, opacity;
      }

      .pointer.visible {
        opacity: 0.96;
      }

      .pointer.hiding {
        opacity: 0;
        transform: var(--pointer-transform, translate(0, 0) scale(1)) scale(0.96);
      }

      .cursor-shape {
        position: absolute;
        top: 0;
        left: 0;
        width: 16px;
        height: 18px;
        filter:
          drop-shadow(0 0.5px 0.6px rgba(17, 24, 39, 0.52))
          drop-shadow(0 2px 4px rgba(17, 24, 39, 0.24));
      }

      .cursor-shape path {
        fill: #5f666f;
        stroke: rgba(17, 24, 39, 0.44);
        stroke-width: 0.8;
        stroke-linejoin: round;
      }

    </style>
  </head>
  <body>
    <div id="pointer" class="pointer" aria-hidden="true">
      <svg class="cursor-shape" viewBox="0 0 32 36" focusable="false">
        <path d="M4 2 L29 22 L14 21 L4 34 Z"></path>
      </svg>
    </div>
    <script>
      (() => {
        const pointer = document.getElementById("pointer");
        const hotspotX = 14.5;
        const hotspotY = 11;
        let hideTimer = undefined;

        window.__vm0ComputerUsePointer = (event) => {
          if (!event || event.type !== "pointer") {
            return;
          }
          window.clearTimeout(hideTimer);
          const transform =
            "translate(" +
            (event.x - hotspotX) +
            "px, " +
            (event.y - hotspotY) +
            "px) scale(1)";
          pointer.style.setProperty("--pointer-transform", transform);
          pointer.style.transform = transform;
          pointer.className = "pointer visible";

          hideTimer = window.setTimeout(() => {
            pointer.className = "pointer hiding";
          }, event.hideDelayMs);
        };
      })();
    </script>
  </body>
</html>`;

function sameBounds(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function overlayUrl(): string {
  return `data:text/html;base64,${Buffer.from(OVERLAY_HTML, "utf8").toString("base64")}`;
}

function scriptCall(event: OverlayPointerEvent): string {
  return `window.__vm0ComputerUsePointer?.(${JSON.stringify(event).replaceAll("<", "\\u003c")})`;
}

export class ComputerUseVisualPointer implements ComputerUseActionVisualizer {
  private window: BrowserWindow | null = null;
  private windowDisplayBounds: Rectangle | null = null;
  private loadPromise: Promise<void> | null = null;

  async showPointer(
    event: ComputerUseActionVisualizerPointerEvent,
  ): Promise<void> {
    const target = {
      x: Math.round(event.screenX),
      y: Math.round(event.screenY),
    };
    const display = screen.getDisplayNearestPoint(target);
    const window = this.ensureWindow(display);
    await this.ensureLoaded(window);
    if (window.isDestroyed()) {
      return;
    }

    const localEvent: OverlayPointerEvent = {
      type: "pointer",
      x: event.screenX - display.bounds.x,
      y: event.screenY - display.bounds.y,
      phase: event.phase,
      hideDelayMs: POINTER_IDLE_HIDE_DELAY_MS,
    };

    window.showInactive();
    window.moveTop();
    await window.webContents.executeJavaScript(scriptCall(localEvent), true);
  }

  destroy(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = null;
      this.loadPromise = null;
      this.windowDisplayBounds = null;
      return;
    }
    this.window.close();
    this.window = null;
    this.loadPromise = null;
    this.windowDisplayBounds = null;
  }

  private ensureWindow(display: Display): BrowserWindow {
    if (
      this.window &&
      !this.window.isDestroyed() &&
      this.windowDisplayBounds &&
      sameBounds(this.windowDisplayBounds, display.bounds)
    ) {
      return this.window;
    }

    this.destroy();
    const window = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      acceptFirstMouse: false,
      roundedCorners: false,
      enableLargerThanScreen: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.setIgnoreMouseEvents(true, { forward: true });
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setAlwaysOnTop(true, "screen-saver");
    this.window = window;
    this.windowDisplayBounds = display.bounds;
    this.loadPromise = window.loadURL(overlayUrl()).then(() => {});
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.loadPromise = null;
        this.windowDisplayBounds = null;
      }
    });
    return window;
  }

  private async ensureLoaded(window: BrowserWindow): Promise<void> {
    if (!this.loadPromise || window.isDestroyed()) {
      return;
    }
    await this.loadPromise;
  }
}
