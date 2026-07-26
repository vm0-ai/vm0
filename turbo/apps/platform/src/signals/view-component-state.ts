import { command, computed, state } from "ccstate";
import { reloadTelegramConnectLinkStatus$ } from "./zero-page/telegram-connect-signals.ts";
import { onRef, setLoop, throwIfAbort } from "./utils.ts";
import { fetchPreviewText } from "./chat-page/artifact-card-signals.ts";

type ImageLoadStatus = "loading" | "loaded" | "error";

export type TextPreviewLoadState = {
  status: "loading" | "loaded" | "error";
  text: string;
};

export const IMAGE_LIGHTBOX_MIN_ZOOM = 0.1;
export const IMAGE_LIGHTBOX_MAX_ZOOM = 3;

const internalImageLoadStatusByKey$ = state<Record<string, ImageLoadStatus>>(
  {},
);
const internalImageLoadStatusRefCountByKey$ = state<Record<string, number>>({});
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

const resetImageLoadStatus$ = command(({ set }, key: string) => {
  set(internalImageLoadStatusByKey$, (current) => {
    const next = { ...current };
    next[key] = "loading";
    return next;
  });
});

const retainImageLoadStatus$ = command(({ get, set }, key: string) => {
  const refCount = get(internalImageLoadStatusRefCountByKey$)[key] ?? 0;
  set(internalImageLoadStatusRefCountByKey$, (current) => {
    return { ...current, [key]: refCount + 1 };
  });
  set(resetImageLoadStatus$, key);
});

const releaseImageLoadStatus$ = command(({ get, set }, key: string) => {
  const refCount = get(internalImageLoadStatusRefCountByKey$)[key] ?? 0;
  if (refCount > 1) {
    set(internalImageLoadStatusRefCountByKey$, (current) => {
      return { ...current, [key]: refCount - 1 };
    });
    return;
  }

  set(internalImageLoadStatusRefCountByKey$, (current) => {
    if (!(key in current)) {
      return current;
    }
    const next = { ...current };
    delete next[key];
    return next;
  });
  set(internalImageLoadStatusByKey$, (current) => {
    if (!(key in current)) {
      return current;
    }
    const next = { ...current };
    delete next[key];
    return next;
  });
});

const resetImageLoadStatusOnRef$ = command(
  ({ set }, el: HTMLElement, signal: AbortSignal) => {
    const key = el.dataset.imageLoadKey;
    if (!key) {
      return;
    }
    set(retainImageLoadStatus$, key);
    signal.addEventListener(
      "abort",
      () => {
        set(releaseImageLoadStatus$, key);
      },
      { once: true },
    );
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
