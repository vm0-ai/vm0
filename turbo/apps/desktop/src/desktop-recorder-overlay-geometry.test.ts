import { describe, expect, it } from "vitest";
import {
  RECORDER_BAR_SIZE,
  RECORDER_CONTROLLER_SIZE,
  recorderControllerBounds,
  areaFromDrag,
  areaToGlobal,
  recorderBarBounds,
} from "./desktop-recorder-overlay-geometry";

/** A display to the right of and above the primary one. */
const secondaryDisplay = { x: 1512, y: -200, width: 1000, height: 500 };

describe("recorderBarBounds", () => {
  it("centres the bar near the bottom of the display", () => {
    const bounds = recorderBarBounds({ x: 0, y: 0, width: 1512, height: 982 });

    expect(bounds.width).toBe(RECORDER_BAR_SIZE.width);
    expect(bounds.height).toBe(RECORDER_BAR_SIZE.height);
    expect(bounds.x).toBe(Math.round((1512 - RECORDER_BAR_SIZE.width) / 2));
    expect(bounds.y).toBeLessThan(982 - RECORDER_BAR_SIZE.height);
  });

  it("keeps the bar on the display it belongs to", () => {
    const bounds = recorderBarBounds(secondaryDisplay);

    // Window positions are global, so a bar placed with display-local numbers
    // would land on the primary screen instead.
    expect(bounds.x).toBeGreaterThanOrEqual(secondaryDisplay.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      secondaryDisplay.x + secondaryDisplay.width,
    );
    expect(bounds.y).toBeGreaterThanOrEqual(secondaryDisplay.y);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      secondaryDisplay.y + secondaryDisplay.height,
    );
  });
});

describe("areaFromDrag", () => {
  it("reads a drag down and to the right", () => {
    expect(areaFromDrag({ x: 100, y: 50 }, { x: 400, y: 250 })).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 200,
    });
  });

  it("reads a drag up and to the left as the same rectangle", () => {
    // Dragging backwards is as ordinary as dragging forwards; a raw difference
    // would give a negative size that crops nothing.
    expect(areaFromDrag({ x: 400, y: 250 }, { x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 200,
    });
  });

  it("gives a click without a drag no size", () => {
    expect(areaFromDrag({ x: 120, y: 80 }, { x: 120, y: 80 })).toEqual({
      x: 120,
      y: 80,
      width: 0,
      height: 0,
    });
  });

  it("rounds to whole points", () => {
    expect(areaFromDrag({ x: 10.4, y: 20.6 }, { x: 100.5, y: 200.4 })).toEqual({
      x: 10,
      y: 21,
      width: 90,
      height: 180,
    });
  });
});

describe("areaToGlobal", () => {
  it("moves a selection drawn on a secondary display into global space", () => {
    const drawn = { x: 100, y: 50, width: 300, height: 200 };

    expect(areaToGlobal(drawn, secondaryDisplay)).toEqual({
      x: 1612,
      y: -150,
      width: 300,
      height: 200,
    });
  });

  it("leaves a selection on the primary display where it is", () => {
    const drawn = { x: 100, y: 50, width: 300, height: 200 };

    expect(
      areaToGlobal(drawn, { x: 0, y: 0, width: 1512, height: 982 }),
    ).toEqual(drawn);
  });
});

describe("recorderControllerBounds", () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 };
  const { width, height } = RECORDER_CONTROLLER_SIZE;

  function overlaps(
    controller: { readonly x: number; readonly y: number },
    captured: { x: number; y: number; width: number; height: number },
  ): boolean {
    return (
      controller.x < captured.x + captured.width &&
      controller.x + width > captured.x &&
      controller.y < captured.y + captured.height &&
      controller.y + height > captured.y
    );
  }

  it("sits below the region when there is room", () => {
    const captured = { x: 200, y: 100, width: 600, height: 400 };

    const bounds = recorderControllerBounds(captured, display);

    expect(bounds.y).toBeGreaterThan(captured.y + captured.height);
    expect(overlaps(bounds, captured)).toBeFalsy();
  });

  it("moves above the region when the bottom is taken", () => {
    const captured = { x: 200, y: 300, width: 600, height: 660 };

    const bounds = recorderControllerBounds(captured, display);

    expect(bounds.y + height).toBeLessThan(captured.y);
    expect(overlaps(bounds, captured)).toBeFalsy();
  });

  it("moves beside the region when neither above nor below fits", () => {
    // A tall strip down the left of the screen.
    const captured = { x: 0, y: 0, width: 400, height: 982 };

    const bounds = recorderControllerBounds(captured, display);

    expect(overlaps(bounds, captured)).toBeFalsy();
    expect(bounds.x).toBeGreaterThanOrEqual(captured.width);
  });

  it("keeps the controller on the display", () => {
    // Region hugging the right edge would centre the controller off-screen.
    const captured = { x: 1400, y: 100, width: 112, height: 200 };

    const bounds = recorderControllerBounds(captured, display);

    expect(bounds.x).toBeGreaterThanOrEqual(display.x);
    expect(bounds.x + width).toBeLessThanOrEqual(display.x + display.width);
  });

  it("places the controller on the right display for a secondary screen", () => {
    const secondary = { x: 1512, y: -200, width: 1000, height: 500 };
    const captured = { x: 1600, y: -100, width: 400, height: 200 };

    const bounds = recorderControllerBounds(captured, secondary);

    expect(bounds.x).toBeGreaterThanOrEqual(secondary.x);
    expect(bounds.x + width).toBeLessThanOrEqual(secondary.x + secondary.width);
    expect(overlaps(bounds, captured)).toBeFalsy();
  });

  it("still shows the controls when the region covers the whole display", () => {
    const captured = { x: 0, y: 0, width: 1512, height: 982 };

    const bounds = recorderControllerBounds(captured, display);

    // Nowhere is outside the region, so overlapping is accepted rather than
    // leaving the user with no way to stop.
    expect(bounds.y + height).toBeLessThanOrEqual(display.y + display.height);
  });
});
