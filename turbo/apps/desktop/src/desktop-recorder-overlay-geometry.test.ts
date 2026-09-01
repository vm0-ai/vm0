import { describe, expect, it } from "vitest";
import {
  RECORDER_BAR_SIZE,
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
