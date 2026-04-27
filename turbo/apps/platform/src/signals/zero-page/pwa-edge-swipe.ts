// PWA-only left-edge swipe-in gesture for opening the mobile sidebar.
//
// Only active in standalone display mode. In browser tabs the left-edge
// area is owned by the native back-navigation gesture, which cannot be
// intercepted. In standalone PWA mode we call preventDefault() on edge
// touchstart/touchmove so the iOS WKWebView back-swipe gesture recognizer
// does NOT fire, because both the sidebar-open swipe and the native
// back-swipe compete for the same left-edge rightward gesture.

import { command } from "ccstate";
import { setSidebarExpanded$ } from "./zero-nav.ts";

export const EDGE_THRESHOLD_PX = 24;
export const OPEN_DISTANCE_PX = 60;
export const MAX_GESTURE_MS = 500;
const HORIZONTAL_RATIO = 2;

interface SwipePoint {
  x: number;
  y: number;
  t: number;
}

function isStandaloneDisplayMode(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches;
}

export function isEdgeStart(x: number): boolean {
  return x <= EDGE_THRESHOLD_PX;
}

export function isOpenSwipe(start: SwipePoint, end: SwipePoint): boolean {
  const dx = end.x - start.x;
  const dy = Math.abs(end.y - start.y);
  const elapsed = end.t - start.t;
  if (elapsed > MAX_GESTURE_MS) {
    return false;
  }
  if (dx < OPEN_DISTANCE_PX) {
    return false;
  }
  if (dx < dy * HORIZONTAL_RATIO) {
    return false;
  }
  return true;
}

export const setupPwaEdgeSwipe$ = command(({ set }, signal: AbortSignal) => {
  if (!isStandaloneDisplayMode()) {
    return;
  }

  let start: SwipePoint | null = null;

  document.addEventListener(
    "touchstart",
    (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      if (!isEdgeStart(touch.clientX)) {
        start = null;
        return;
      }
      // Claim the gesture to prevent iOS WKWebView native back-swipe.
      event.preventDefault();
      start = { x: touch.clientX, y: touch.clientY, t: Date.now() };
    },
    { signal },
  );

  document.addEventListener(
    "touchmove",
    (event: TouchEvent) => {
      if (!start) {
        return;
      }
      // Continue preventing the native back-swipe during the gesture.
      // Avoid calling preventDefault() on vertical movements (> dy) to
      // allow vertical scrolling even when the touch started at the edge.
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dx > dy) {
        event.preventDefault();
      }
    },
    { signal },
  );

  document.addEventListener(
    "touchend",
    (event: TouchEvent) => {
      if (!start) {
        return;
      }
      const touch = event.changedTouches[0];
      if (touch) {
        const end: SwipePoint = {
          x: touch.clientX,
          y: touch.clientY,
          t: Date.now(),
        };
        if (isOpenSwipe(start, end)) {
          set(setSidebarExpanded$, true);
        }
      }
      start = null;
    },
    { signal },
  );

  document.addEventListener(
    "touchcancel",
    () => {
      start = null;
    },
    { signal },
  );
});
