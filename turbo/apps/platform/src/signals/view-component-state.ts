import { command, computed, state } from "ccstate";
import { reloadTelegramConnectLinkStatus$ } from "./zero-page/telegram-connect-signals.ts";
import { onRef, throwIfAbort } from "./utils.ts";
import { fetchPreviewText } from "./chat-page/parse-body-blocks.ts";

type ImageLoadStatus = "loading" | "loaded" | "error";
type ZoomableTouchPoint = {
  clientX: number;
  clientY: number;
  pointerId: number;
};
type ZoomableTouchGestureState =
  | {
      clientX: number;
      clientY: number;
      kind: "pan";
      pointerId: number;
      scrollLeft: number;
      scrollTop: number;
    }
  | {
      contentX: number;
      contentY: number;
      distance: number;
      kind: "pinch";
      zoom: number;
    };
type ZoomableTouchSurfaceState = {
  gesture: ZoomableTouchGestureState | null;
  pointers: Map<number, ZoomableTouchPoint>;
};
type ZoomableImageInteractionContext = {
  displayZoom: number;
  el: HTMLDivElement;
  touchState: ZoomableTouchSurfaceState;
};
type ZoomableImageZoomUpdate = {
  nextZoom: number;
  scrollLeft: number;
  scrollTop: number;
};

export type TextPreviewLoadState = {
  status: "loading" | "loaded" | "error";
  text: string;
};

export const IMAGE_LIGHTBOX_MIN_ZOOM = 0.5;
export const IMAGE_LIGHTBOX_MAX_ZOOM = 3;
const TRACKPAD_PINCH_ZOOM_STEP = 0.006;

const internalImageLoadStatusByKey$ = state<Record<string, ImageLoadStatus>>(
  {},
);
const internalZoomableImageCanvasFitWidthByKey$ = state<Record<string, number>>(
  {},
);
const internalZoomableImageCanvasZoomByKey$ = state<Record<string, number>>({});
const internalTextPreviewLoadStateByKey$ = state<
  Record<string, TextPreviewLoadState>
>({});
const internalTypewriterDisplayedByKey$ = state<Record<string, string>>({});

export const imageLoadStatusByKey$ = computed((get) => {
  return get(internalImageLoadStatusByKey$);
});

export const zoomableImageCanvasZoomByKey$ = computed((get) => {
  return get(internalZoomableImageCanvasZoomByKey$);
});

export const zoomableImageCanvasFitWidthByKey$ = computed((get) => {
  return get(internalZoomableImageCanvasFitWidthByKey$);
});

export const textPreviewLoadStateByKey$ = computed((get) => {
  return get(internalTextPreviewLoadStateByKey$);
});

export const typewriterDisplayed$ = computed((get) => {
  return get(internalTypewriterDisplayedByKey$);
});

export const setImageLoadStatus$ = command(
  ({ set }, key: string, status: ImageLoadStatus) => {
    set(internalImageLoadStatusByKey$, (current) => {
      return { ...current, [key]: status };
    });
  },
);

function clampImageZoom(zoom: number) {
  return Math.min(
    IMAGE_LIGHTBOX_MAX_ZOOM,
    Math.max(IMAGE_LIGHTBOX_MIN_ZOOM, zoom),
  );
}

function roundImageZoom(zoom: number) {
  return Math.round(clampImageZoom(zoom) * 10_000) / 10_000;
}

export const setZoomableImageCanvasZoom$ = command(
  ({ set }, key: string, zoom: number) => {
    set(internalZoomableImageCanvasZoomByKey$, (current) => {
      return { ...current, [key]: roundImageZoom(zoom) };
    });
  },
);

export const setZoomableImageCanvasFitWidth$ = command(
  ({ set }, key: string, fitWidth: number) => {
    if (!Number.isFinite(fitWidth) || fitWidth <= 0) {
      return;
    }

    set(internalZoomableImageCanvasFitWidthByKey$, (current) => {
      return { ...current, [key]: Math.round(fitWidth) };
    });
  },
);

export const resetZoomableImageCanvasZoom$ = command(({ set }, key: string) => {
  set(internalZoomableImageCanvasZoomByKey$, (current) => {
    return { ...current, [key]: 1 };
  });
});

function nextPinchZoom(currentZoom: number, deltaY: number) {
  const zoomDelta = -deltaY * TRACKPAD_PINCH_ZOOM_STEP;
  return Math.min(
    IMAGE_LIGHTBOX_MAX_ZOOM,
    Math.max(IMAGE_LIGHTBOX_MIN_ZOOM, currentZoom + zoomDelta),
  );
}

function shouldIgnoreTouchGestureStart(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return true;
  }
  return Boolean(
    target.closest("button, a, input, textarea, select, [role='button']"),
  );
}

function touchDistance(a: ZoomableTouchPoint, b: ZoomableTouchPoint) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchMidpoint(a: ZoomableTouchPoint, b: ZoomableTouchPoint) {
  return {
    clientX: (a.clientX + b.clientX) / 2,
    clientY: (a.clientY + b.clientY) / 2,
  };
}

function firstTwoTouchPoints(
  touchPointers: Map<number, ZoomableTouchPoint>,
): [ZoomableTouchPoint, ZoomableTouchPoint] | null {
  const points = Array.from(touchPointers.values());
  const [first, second] = points;
  return first && second ? [first, second] : null;
}

function anchoredImageZoomUpdate({
  clientX,
  clientY,
  currentZoom,
  el,
  nextZoom,
}: {
  clientX: number;
  clientY: number;
  currentZoom: number;
  el: HTMLDivElement;
  nextZoom: number;
}): ZoomableImageZoomUpdate | null {
  if (nextZoom === currentZoom) {
    return null;
  }

  const zoomRatio = nextZoom / currentZoom;
  const rect = el.getBoundingClientRect();
  const viewportX = clientX - rect.x;
  const viewportY = clientY - rect.y;
  const contentX = el.scrollLeft + viewportX;
  const contentY = el.scrollTop + viewportY;

  return {
    nextZoom,
    scrollLeft: contentX * zoomRatio - viewportX,
    scrollTop: contentY * zoomRatio - viewportY,
  };
}

function startTouchPanGesture(
  context: ZoomableImageInteractionContext,
  pointer: ZoomableTouchPoint,
) {
  context.touchState.gesture = {
    clientX: pointer.clientX,
    clientY: pointer.clientY,
    kind: "pan",
    pointerId: pointer.pointerId,
    scrollLeft: context.el.scrollLeft,
    scrollTop: context.el.scrollTop,
  };
}

function startTouchPinchGesture(context: ZoomableImageInteractionContext) {
  const points = firstTwoTouchPoints(context.touchState.pointers);
  if (!points) {
    return;
  }

  const [first, second] = points;
  const distance = touchDistance(first, second);
  if (distance <= 0) {
    return;
  }

  const midpoint = touchMidpoint(first, second);
  const rect = context.el.getBoundingClientRect();
  const viewportX = midpoint.clientX - rect.x;
  const viewportY = midpoint.clientY - rect.y;

  context.touchState.gesture = {
    contentX: context.el.scrollLeft + viewportX,
    contentY: context.el.scrollTop + viewportY,
    distance,
    kind: "pinch",
    zoom: context.displayZoom,
  };
}

function applyTouchPanGesture(
  context: ZoomableImageInteractionContext,
  gesture: Extract<ZoomableTouchGestureState, { kind: "pan" }>,
) {
  const pointer = context.touchState.pointers.get(gesture.pointerId);
  if (!pointer) {
    return;
  }

  context.el.scrollLeft =
    gesture.scrollLeft - (pointer.clientX - gesture.clientX);
  context.el.scrollTop =
    gesture.scrollTop - (pointer.clientY - gesture.clientY);
}

function applyTouchPinchGesture(
  context: ZoomableImageInteractionContext,
  gesture: Extract<ZoomableTouchGestureState, { kind: "pinch" }>,
): ZoomableImageZoomUpdate | null {
  const points = firstTwoTouchPoints(context.touchState.pointers);
  if (!points) {
    return null;
  }

  const [first, second] = points;
  const nextDistance = touchDistance(first, second);
  if (nextDistance <= 0) {
    return null;
  }

  const midpoint = touchMidpoint(first, second);
  const nextZoom = clampImageZoom(
    gesture.zoom * (nextDistance / gesture.distance),
  );
  const zoomRatio = nextZoom / gesture.zoom;
  const rect = context.el.getBoundingClientRect();
  const viewportX = midpoint.clientX - rect.x;
  const viewportY = midpoint.clientY - rect.y;

  return {
    nextZoom,
    scrollLeft: gesture.contentX * zoomRatio - viewportX,
    scrollTop: gesture.contentY * zoomRatio - viewportY,
  };
}

function applyTouchGesture(
  context: ZoomableImageInteractionContext,
): ZoomableImageZoomUpdate | null {
  const gesture = context.touchState.gesture;
  if (!gesture) {
    return null;
  }

  if (gesture.kind === "pan") {
    applyTouchPanGesture(context, gesture);
    return null;
  }

  return applyTouchPinchGesture(context, gesture);
}

function refreshTouchGestureAfterPointerRelease(
  context: ZoomableImageInteractionContext,
) {
  if (context.touchState.pointers.size >= 2) {
    startTouchPinchGesture(context);
    return;
  }

  const [remainingPointer] = context.touchState.pointers.values();
  if (remainingPointer) {
    startTouchPanGesture(context, remainingPointer);
    return;
  }

  context.touchState.gesture = null;
}

function handleTouchPointerDown(
  event: PointerEvent,
  context: ZoomableImageInteractionContext,
) {
  if (
    event.pointerType !== "touch" ||
    shouldIgnoreTouchGestureStart(event.target)
  ) {
    return;
  }

  event.preventDefault();
  if (typeof context.el.setPointerCapture === "function") {
    context.el.setPointerCapture(event.pointerId);
  }

  const pointer = {
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
  };
  context.touchState.pointers.set(event.pointerId, pointer);

  if (context.touchState.pointers.size >= 2) {
    startTouchPinchGesture(context);
    return;
  }

  startTouchPanGesture(context, pointer);
}

function handleTouchPointerMove(
  event: PointerEvent,
  context: ZoomableImageInteractionContext,
): ZoomableImageZoomUpdate | null {
  if (
    event.pointerType !== "touch" ||
    !context.touchState.pointers.has(event.pointerId)
  ) {
    return null;
  }

  event.preventDefault();
  context.touchState.pointers.set(event.pointerId, {
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
  });
  return applyTouchGesture(context);
}

function handleTouchPointerEnd(
  event: PointerEvent,
  context: ZoomableImageInteractionContext,
) {
  if (
    event.pointerType !== "touch" ||
    !context.touchState.pointers.has(event.pointerId)
  ) {
    return;
  }

  event.preventDefault();
  context.touchState.pointers.delete(event.pointerId);
  if (typeof context.el.releasePointerCapture === "function") {
    context.el.releasePointerCapture(event.pointerId);
  }
  refreshTouchGestureAfterPointerRelease(context);
}

export const zoomableImageCanvasInteractionRef$ = onRef(
  command(({ get, set }, el: HTMLDivElement, signal: AbortSignal) => {
    const touchState: ZoomableTouchSurfaceState = {
      gesture: null,
      pointers: new Map<number, ZoomableTouchPoint>(),
    };
    const interactionContext = (
      displayZoom: number,
    ): ZoomableImageInteractionContext => {
      return {
        displayZoom,
        el,
        touchState,
      };
    };

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }

      const zoomKey = el.dataset.zoomKey;
      if (!zoomKey) {
        return;
      }
      const displayZoom = get(zoomableImageCanvasZoomByKey$)[zoomKey] ?? 1;

      event.preventDefault();
      event.stopPropagation();

      const nextZoom = nextPinchZoom(displayZoom, event.deltaY);
      const update = anchoredImageZoomUpdate({
        clientX: event.clientX,
        clientY: event.clientY,
        currentZoom: displayZoom,
        el,
        nextZoom,
      });
      if (!update) {
        return;
      }

      set(setZoomableImageCanvasZoom$, zoomKey, update.nextZoom);
      el.scrollLeft = update.scrollLeft;
      el.scrollTop = update.scrollTop;
    };

    const handlePointerDown = (event: PointerEvent) => {
      const zoomKey = el.dataset.zoomKey;
      if (!zoomKey) {
        return;
      }
      const displayZoom = get(zoomableImageCanvasZoomByKey$)[zoomKey] ?? 1;
      handleTouchPointerDown(event, interactionContext(displayZoom));
    };

    const handlePointerMove = (event: PointerEvent) => {
      const zoomKey = el.dataset.zoomKey;
      if (!zoomKey) {
        return;
      }
      const displayZoom = get(zoomableImageCanvasZoomByKey$)[zoomKey] ?? 1;
      const update = handleTouchPointerMove(
        event,
        interactionContext(displayZoom),
      );
      if (!update) {
        return;
      }

      set(setZoomableImageCanvasZoom$, zoomKey, update.nextZoom);
      el.scrollLeft = update.scrollLeft;
      el.scrollTop = update.scrollTop;
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const zoomKey = el.dataset.zoomKey;
      if (!zoomKey) {
        return;
      }
      const displayZoom = get(zoomableImageCanvasZoomByKey$)[zoomKey] ?? 1;
      handleTouchPointerEnd(event, interactionContext(displayZoom));
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    el.addEventListener("pointerdown", handlePointerDown);
    el.addEventListener("pointermove", handlePointerMove);
    el.addEventListener("pointerup", handlePointerEnd);
    el.addEventListener("pointercancel", handlePointerEnd);
    signal.addEventListener("abort", () => {
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("pointerdown", handlePointerDown);
      el.removeEventListener("pointermove", handlePointerMove);
      el.removeEventListener("pointerup", handlePointerEnd);
      el.removeEventListener("pointercancel", handlePointerEnd);
    });
  }),
);

const resetImageLoadStatus$ = command(({ set }, key: string) => {
  set(internalImageLoadStatusByKey$, (current) => {
    const next = { ...current };
    next[key] = "loading";
    return next;
  });
});

const resetImageLoadStatusOnRef$ = command(
  ({ set }, el: HTMLElement, _signal: AbortSignal) => {
    const key = el.dataset.imageLoadKey;
    if (!key) {
      return;
    }
    set(resetImageLoadStatus$, key);
  },
);

export const imageLoadStatusRef$ = onRef(resetImageLoadStatusOnRef$);

export const textPreviewLoaderRef$ = onRef(
  command(async ({ set }, el: HTMLElement, signal: AbortSignal) => {
    const key = el.dataset.textPreviewKey;
    const url = el.dataset.textPreviewUrl;
    if (!key || !url) {
      return;
    }

    set(internalTextPreviewLoadStateByKey$, (current) => {
      const next = { ...current };
      next[key] = { status: "loading", text: "" };
      return next;
    });

    // The try-catch block here can probably be removed. Currently, the internal
    // textPreviewLoadStateByKey seems to have some issues, but let's prioritize
    // fixing the pointCache (upvote cache) problem first.
    // For now, I'll just add a TODO for the try-catch issue.
    // confirmed by ethan@vm0.ai
    // eslint-disable-next-line no-restricted-syntax
    try {
      const text = await fetchPreviewText(url, signal);

      set(internalTextPreviewLoadStateByKey$, (current) => {
        const next = { ...current };
        next[key] = { status: "loaded", text };
        return next;
      });
    } catch (error) {
      throwIfAbort(error);
      set(internalTextPreviewLoadStateByKey$, (current) => {
        const next = { ...current };
        next[key] = { status: "error", text: "" };
        return next;
      });
    }
  }),
);

const resetTypewriterDisplayed$ = command(({ set }, key: string) => {
  set(internalTypewriterDisplayedByKey$, (current) => {
    return { ...current, [key]: "" };
  });
});

const setTypewriterDisplayed$ = command(
  ({ set }, key: string, displayed: string) => {
    set(internalTypewriterDisplayedByKey$, (current) => {
      return { ...current, [key]: displayed };
    });
  },
);

const startTypewriterOnRef$ = command(
  ({ set }, el: HTMLElement, signal: AbortSignal) => {
    const key = el.dataset.typewriterKey;
    const text = el.dataset.typewriterText ?? "";
    const parsedSpeed = Number.parseInt(el.dataset.typewriterSpeed ?? "40", 10);
    const speed = Number.isFinite(parsedSpeed) ? parsedSpeed : 40;

    if (!key) {
      return;
    }

    set(resetTypewriterDisplayed$, key);
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      set(setTypewriterDisplayed$, key, text.slice(0, index));
      if (index >= text.length) {
        window.clearInterval(timer);
      }
    }, speed);

    signal.addEventListener(
      "abort",
      () => {
        window.clearInterval(timer);
      },
      { once: true },
    );
  },
);

export const typewriterRef$ = onRef(startTypewriterOnRef$);

const openTelegramOnRef$ = command(
  (_ctx, el: HTMLElement, _signal: AbortSignal) => {
    const href = el.dataset.telegramHref;
    if (!href) {
      return;
    }
    window.location.assign(href);
  },
);

export const telegramAutoOpenRef$ = onRef(openTelegramOnRef$);

const pollTelegramDomainStatusOnRef$ = command(
  ({ set }, _el: HTMLElement, signal: AbortSignal) => {
    const intervalId = window.setInterval(() => {
      set(reloadTelegramConnectLinkStatus$);
    }, 3000);

    signal.addEventListener(
      "abort",
      () => {
        window.clearInterval(intervalId);
      },
      { once: true },
    );
  },
);

export const telegramDomainStatusPollerRef$ = onRef(
  pollTelegramDomainStatusOnRef$,
);
