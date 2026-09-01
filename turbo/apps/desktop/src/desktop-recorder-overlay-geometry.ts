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
