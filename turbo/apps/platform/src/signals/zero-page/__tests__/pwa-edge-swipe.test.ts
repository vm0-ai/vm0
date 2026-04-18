import { describe, expect, it } from "vitest";
import {
  EDGE_THRESHOLD_PX,
  isEdgeStart,
  isOpenSwipe,
  MAX_GESTURE_MS,
  OPEN_DISTANCE_PX,
} from "../pwa-edge-swipe.ts";

describe("isEdgeStart", () => {
  it("accepts coordinates at or within the edge threshold", () => {
    expect(isEdgeStart(0)).toBeTruthy();
    expect(isEdgeStart(EDGE_THRESHOLD_PX)).toBeTruthy();
  });

  it("rejects coordinates beyond the edge threshold", () => {
    expect(isEdgeStart(EDGE_THRESHOLD_PX + 1)).toBeFalsy();
    expect(isEdgeStart(200)).toBeFalsy();
  });
});

describe("isOpenSwipe", () => {
  it("accepts a horizontal swipe past the open distance within the time window", () => {
    expect(
      isOpenSwipe(
        { x: 5, y: 200, t: 0 },
        { x: 5 + OPEN_DISTANCE_PX, y: 205, t: 150 },
      ),
    ).toBeTruthy();
  });

  it("rejects short horizontal movements (a tap)", () => {
    expect(
      isOpenSwipe({ x: 5, y: 200, t: 0 }, { x: 20, y: 200, t: 50 }),
    ).toBeFalsy();
  });

  it("rejects gestures that take longer than the max window", () => {
    expect(
      isOpenSwipe(
        { x: 5, y: 200, t: 0 },
        { x: 200, y: 200, t: MAX_GESTURE_MS + 1 },
      ),
    ).toBeFalsy();
  });

  it("rejects gestures that are mostly vertical", () => {
    expect(
      isOpenSwipe({ x: 5, y: 100, t: 0 }, { x: 80, y: 400, t: 200 }),
    ).toBeFalsy();
  });

  it("rejects leftward movement (dx < 0)", () => {
    expect(
      isOpenSwipe({ x: 5, y: 200, t: 0 }, { x: -100, y: 200, t: 100 }),
    ).toBeFalsy();
  });
});
