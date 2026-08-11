import { command, computed, state } from "ccstate";
import { reloadTelegramConnectLinkStatus$ } from "./zero-page/telegram-connect-signals.ts";
import { onRef, setLoop } from "./utils.ts";

export const IMAGE_LIGHTBOX_MIN_ZOOM = 0.1;
export const IMAGE_LIGHTBOX_MAX_ZOOM = 3;

const internalZoomableImageCanvasFitWidthByKey$ = state<Record<string, number>>(
  {},
);
const internalZoomableImageCanvasZoomByKey$ = state<Record<string, number>>({});
const internalTypewriterDisplayedByKey$ = state<Record<string, string>>({});

export const zoomableImageCanvasZoomByKey$ = computed((get) => {
  return get(internalZoomableImageCanvasZoomByKey$);
});

export const zoomableImageCanvasFitWidthByKey$ = computed((get) => {
  return get(internalZoomableImageCanvasFitWidthByKey$);
});

export const typewriterDisplayed$ = computed((get) => {
  return get(internalTypewriterDisplayedByKey$);
});

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
  async ({ set }, el: HTMLElement, signal: AbortSignal) => {
    const key = el.dataset.typewriterKey;
    const text = el.dataset.typewriterText ?? "";
    const parsedSpeed = Number.parseInt(el.dataset.typewriterSpeed ?? "40", 10);
    const speed = Number.isFinite(parsedSpeed) ? parsedSpeed : 40;

    if (!key) {
      return;
    }

    set(resetTypewriterDisplayed$, key);
    let index = 0;
    await setLoop(
      () => {
        index += 1;
        set(setTypewriterDisplayed$, key, text.slice(0, index));
        return index >= text.length;
      },
      speed,
      signal,
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
  async ({ set }, _el: HTMLElement, signal: AbortSignal) => {
    let first = true;
    await setLoop(
      () => {
        if (first) {
          first = false;
          return false;
        }
        set(reloadTelegramConnectLinkStatus$);
        return false;
      },
      3000,
      signal,
    );
  },
);

export const telegramDomainStatusPollerRef$ = onRef(
  pollTelegramDomainStatusOnRef$,
);
