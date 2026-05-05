import { command, computed, state } from "ccstate";
import { reloadTelegramConnectLinkStatus$ } from "./zero-page/telegram-connect-signals.ts";
import { onRef, throwIfAbort } from "./utils.ts";
import { fetchPreviewText } from "./chat-page/parse-body-blocks.ts";

type ImageLoadStatus = "loading" | "loaded" | "error";

export type TextPreviewLoadState = {
  status: "loading" | "loaded" | "error";
  text: string;
};

type ImageLightboxImageState = {
  imageStatus: ImageLoadStatus;
  zoom: number;
};

export const IMAGE_LIGHTBOX_MIN_ZOOM = 0.5;
export const IMAGE_LIGHTBOX_MAX_ZOOM = 3;
const IMAGE_LIGHTBOX_ZOOM_STEP = 0.25;

const internalImageLoadStatusByKey$ = state<Record<string, ImageLoadStatus>>(
  {},
);
const internalTextPreviewLoadStateByKey$ = state<
  Record<string, TextPreviewLoadState>
>({});
const internalTextPreviewCollapsedByKey$ = state<Record<string, boolean>>({});
const internalTypewriterDisplayedByKey$ = state<Record<string, string>>({});
const internalImageLightboxState$ = state<ImageLightboxImageState>({
  imageStatus: "loading",
  zoom: 1,
});

export const imageLoadStatusByKey$ = computed((get) => {
  return get(internalImageLoadStatusByKey$);
});

export const textPreviewLoadStateByKey$ = computed((get) => {
  return get(internalTextPreviewLoadStateByKey$);
});

export const textPreviewCollapsedByKey$ = computed((get) => {
  return get(internalTextPreviewCollapsedByKey$);
});

export const typewriterDisplayed$ = computed((get) => {
  return get(internalTypewriterDisplayedByKey$);
});

export const imageLightboxState$ = computed((get) => {
  return get(internalImageLightboxState$);
});

export const setImageLoadStatus$ = command(
  ({ set }, key: string, status: ImageLoadStatus) => {
    set(internalImageLoadStatusByKey$, (current) => {
      return { ...current, [key]: status };
    });
  },
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

export const toggleTextPreviewCollapsed$ = command(({ set }, key: string) => {
  set(internalTextPreviewCollapsedByKey$, (current) => {
    return { ...current, [key]: !(current[key] ?? false) };
  });
});

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

function clampImageLightboxZoom(zoom: number): number {
  return Math.min(
    IMAGE_LIGHTBOX_MAX_ZOOM,
    Math.max(IMAGE_LIGHTBOX_MIN_ZOOM, zoom),
  );
}

const resetImageLightboxState$ = command(({ set }) => {
  set(internalImageLightboxState$, { imageStatus: "loading", zoom: 1 });
});

export const setImageLightboxStatus$ = command(
  ({ set }, status: ImageLoadStatus) => {
    set(internalImageLightboxState$, (current) => {
      return { ...current, imageStatus: status };
    });
  },
);

export const zoomImageLightboxIn$ = command(({ set }) => {
  set(internalImageLightboxState$, (current) => {
    return {
      ...current,
      zoom: clampImageLightboxZoom(current.zoom + IMAGE_LIGHTBOX_ZOOM_STEP),
    };
  });
});

export const zoomImageLightboxOut$ = command(({ set }) => {
  set(internalImageLightboxState$, (current) => {
    return {
      ...current,
      zoom: clampImageLightboxZoom(current.zoom - IMAGE_LIGHTBOX_ZOOM_STEP),
    };
  });
});

export const resetImageLightboxZoom$ = command(({ set }) => {
  set(internalImageLightboxState$, (current) => {
    return { ...current, zoom: 1 };
  });
});

const resetImageLightboxOnRef$ = command(
  ({ set }, _el: HTMLElement, _signal: AbortSignal) => {
    set(resetImageLightboxState$);
  },
);

export const imageLightboxImageRef$ = onRef(resetImageLightboxOnRef$);

const imageLightboxKeyboardShortcutsOnRef$ = command(
  ({ set }, _el: HTMLElement, signal: AbortSignal) => {
    document.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (!event.metaKey && !event.ctrlKey) {
          return;
        }

        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          event.stopPropagation();
          set(zoomImageLightboxIn$);
          return;
        }

        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          event.stopPropagation();
          set(zoomImageLightboxOut$);
          return;
        }

        if (event.key === "0") {
          event.preventDefault();
          event.stopPropagation();
          set(resetImageLightboxZoom$);
        }
      },
      { signal },
    );
  },
);

export const imageLightboxKeyboardShortcutsRef$ = onRef(
  imageLightboxKeyboardShortcutsOnRef$,
);

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
