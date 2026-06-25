import { command, computed, state } from "ccstate";
import { reloadTelegramConnectLinkStatus$ } from "./zero-page/telegram-connect-signals.ts";
import { onRef, throwIfAbort } from "./utils.ts";
import { fetchPreviewText } from "./chat-page/parse-body-blocks.ts";

type ImageLoadStatus = "loading" | "loaded" | "error";

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

export const zoomableImageCanvasWheelRef$ = onRef(
  command(({ get, set }, el: HTMLDivElement, signal: AbortSignal) => {
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }

      const zoomKey = el.dataset.zoomKey;
      if (!zoomKey) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const displayZoom = get(zoomableImageCanvasZoomByKey$)[zoomKey] ?? 1;
      const nextZoom = nextPinchZoom(displayZoom, event.deltaY);
      if (nextZoom === displayZoom) {
        return;
      }

      const zoomRatio = nextZoom / displayZoom;
      const viewportX = event.clientX - el.getBoundingClientRect().x;
      const viewportY = event.clientY - el.getBoundingClientRect().y;
      const contentX = el.scrollLeft + viewportX;
      const contentY = el.scrollTop + viewportY;

      set(setZoomableImageCanvasZoom$, zoomKey, nextZoom);
      el.scrollLeft = contentX * zoomRatio - viewportX;
      el.scrollTop = contentY * zoomRatio - viewportY;
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    signal.addEventListener("abort", () => {
      el.removeEventListener("wheel", handleWheel);
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
