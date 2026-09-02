import type { DesktopRecorderArea } from "./desktop-recorder-types";

interface OverlayDisplayBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Height of the bar's own surface, in points. Mirrors `.recorder-bar` in
 * `renderer/recorder/recorder.css`.
 */
const RECORDER_BAR_PILL_HEIGHT = 116;

/**
 * Room kept below every overlay surface for the message it shows when
 * something fails, in points. Mirrors `.recorder-bar__error` and
 * `.recording-controller__error`, which sit just under their surface.
 *
 * The window is what the system clips to, so a message drawn outside these
 * bounds is not dimmed or cut off — it is never on screen at all, and the
 * failure looks like a button that did nothing.
 */
const RECORDER_MESSAGE_BAND_HEIGHT = 34;

/**
 * Size of the floating recorder bar window, in points.
 *
 * The width matches what the controls actually occupy. A wider window would
 * leave the row padded out with dead space, since nothing in the bar stretches.
 */
export const RECORDER_BAR_SIZE = Object.freeze({
  width: 866,
  height: RECORDER_BAR_PILL_HEIGHT + RECORDER_MESSAGE_BAND_HEIGHT,
});

/** Gap between the bar and the bottom edge of the screen, in points. */
const RECORDER_BAR_BOTTOM_MARGIN = 72;

/**
 * Places the recorder bar near the bottom of a display, horizontally centred.
 *
 * Coordinates are global, because `BrowserWindow` positions are global and a
 * bar placed with display-local numbers lands on the wrong screen.
 */
export function recorderBarBounds(display: OverlayDisplayBounds): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    x: Math.round(display.x + (display.width - RECORDER_BAR_SIZE.width) / 2),
    y: Math.round(
      display.y +
        display.height -
        RECORDER_BAR_SIZE.height -
        RECORDER_BAR_BOTTOM_MARGIN,
    ),
    width: RECORDER_BAR_SIZE.width,
    height: RECORDER_BAR_SIZE.height,
  };
}

/**
 * Turns the two corners of a drag into a rectangle.
 *
 * Dragging up or to the left is as ordinary as dragging down and right, so the
 * corners are ordered rather than assumed; a raw `end - start` would produce a
 * negative size that crops nothing.
 */
export function areaFromDrag(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): DesktopRecorderArea {
  return {
    x: Math.round(Math.min(start.x, end.x)),
    y: Math.round(Math.min(start.y, end.y)),
    width: Math.round(Math.abs(end.x - start.x)),
    height: Math.round(Math.abs(end.y - start.y)),
  };
}

/**
 * Moves a rectangle drawn in a display-local overlay into global coordinates,
 * which is the space the capture request is expressed in.
 */
export function areaToGlobal(
  area: DesktopRecorderArea,
  display: OverlayDisplayBounds,
): DesktopRecorderArea {
  return {
    x: area.x + display.x,
    y: area.y + display.y,
    width: area.width,
    height: area.height,
  };
}

/**
 * Height of the controller's own surface, in points. Mirrors
 * `.recording-controller` in `renderer/recorder/recorder.css`.
 */
const RECORDER_CONTROLLER_SURFACE_HEIGHT = 60;

/**
 * Size of the controller window shown while a recording is running, in points,
 * including the room its failure message needs.
 */
export const RECORDER_CONTROLLER_SIZE = Object.freeze({
  width: 268,
  height: RECORDER_CONTROLLER_SURFACE_HEIGHT + RECORDER_MESSAGE_BAND_HEIGHT,
});

/** Size of the window picker, in points. Fits a three-column grid. */
export const RECORDER_WINDOW_PICKER_SIZE = Object.freeze({
  width: 900,
  height: 620,
});

/** Centres a window inside a display's work area, in global coordinates. */
export function centredBounds(
  display: OverlayDisplayBounds,
  size: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  return {
    x: Math.round(display.x + (display.width - size.width) / 2),
    y: Math.round(display.y + (display.height - size.height) / 2),
  };
}

/**
 * Places an overlay along the bottom of a display, horizontally centred, which
 * is where controls belong when there is no region to sit beside.
 */
export function bottomCentredBounds(
  display: OverlayDisplayBounds,
  size: { readonly width: number; readonly height: number },
  margin: number,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.round(display.x + (display.width - size.width) / 2),
    y: Math.round(display.y + display.height - size.height - margin),
  };
}

/** Clearance kept between the controller and the region being recorded. */
const CONTROLLER_CLEARANCE = 16;

/**
 * Places the recording controller so it stays out of the captured region.
 *
 * An area capture is the one case where the controller can be kept out of the
 * video without asking the system to exclude a window: the region is known, so
 * the controller is simply put beside it. Below the region is preferred, then
 * above; if neither fits, it goes to whichever side has room, and only when the
 * region leaves no room anywhere does it fall back to overlapping.
 */
export function recorderControllerBounds(
  captured: DesktopRecorderArea,
  display: OverlayDisplayBounds,
): { readonly x: number; readonly y: number } {
  const { width, height } = RECORDER_CONTROLLER_SIZE;
  const centredX = Math.round(captured.x + (captured.width - width) / 2);
  const x = Math.min(
    Math.max(centredX, display.x),
    display.x + display.width - width,
  );

  const below = captured.y + captured.height + CONTROLLER_CLEARANCE;
  if (below + height <= display.y + display.height) {
    return { x, y: Math.round(below) };
  }

  const above = captured.y - CONTROLLER_CLEARANCE - height;
  if (above >= display.y) {
    return { x, y: Math.round(above) };
  }

  const rightOf = captured.x + captured.width + CONTROLLER_CLEARANCE;
  if (rightOf + width <= display.x + display.width) {
    return {
      x: Math.round(rightOf),
      y: Math.round(
        Math.min(
          Math.max(captured.y, display.y),
          display.y + display.height - height,
        ),
      ),
    };
  }

  const leftOf = captured.x - CONTROLLER_CLEARANCE - width;
  if (leftOf >= display.x) {
    return {
      x: Math.round(leftOf),
      y: Math.round(
        Math.min(
          Math.max(captured.y, display.y),
          display.y + display.height - height,
        ),
      ),
    };
  }

  // The region covers the display: nowhere is outside it, so sit at the bottom
  // and accept being in frame rather than hiding the controls entirely.
  return {
    x,
    y: Math.round(display.y + display.height - height - CONTROLLER_CLEARANCE),
  };
}
