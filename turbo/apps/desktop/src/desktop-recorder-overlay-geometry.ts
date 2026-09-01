import type { DesktopRecorderArea } from "./desktop-recorder-types";

export interface OverlayDisplayBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Size of the floating recorder bar, in points.
 *
 * The width matches what the controls actually occupy. A wider window would
 * leave the row padded out with dead space, since nothing in the bar stretches.
 */
export const RECORDER_BAR_SIZE = Object.freeze({ width: 866, height: 116 });

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

/** Size of the controller shown while a recording is running, in points. */
export const RECORDER_CONTROLLER_SIZE = Object.freeze({
  width: 268,
  height: 60,
});

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
