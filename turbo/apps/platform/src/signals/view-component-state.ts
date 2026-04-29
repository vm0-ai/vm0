import { command, computed, state } from "ccstate";
import { maybePageSignal$ } from "./page-signal.ts";
import { reloadTelegramConnectLinkStatus$ } from "./zero-page/telegram-connect-signals.ts";
import { onRef } from "./utils.ts";

type ImageLoadStatus = "loading" | "loaded" | "error";

export type TextPreviewLoadState = {
  status: "loading" | "loaded" | "error";
  text: string;
};

type ImageLightboxImageState = {
  imageStatus: ImageLoadStatus;
  zoom: number;
};

const TEXT_PREVIEW_MAX_BYTES = 65_536;
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

function toRawUrl(url: string): string {
  if (!URL.canParse(url, window.location.origin)) {
    const hashIndex = url.indexOf("#");
    const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
    if (base.includes("raw=1")) {
      return url;
    }
    return `${base}${base.includes("?") ? "&" : "?"}raw=1${hash}`;
  }

  const parsed = new URL(url, window.location.origin);
  if (parsed.searchParams.get("raw") !== "1") {
    parsed.searchParams.set("raw", "1");
  }
  return parsed.toString();
}

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let reachedLimit = false;

  while (received < TEXT_PREVIEW_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const remaining = TEXT_PREVIEW_MAX_BYTES - received;
    const chunk =
      value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
    if (received >= TEXT_PREVIEW_MAX_BYTES) {
      reachedLimit = true;
      break;
    }
  }

  if (reachedLimit) {
    await reader.cancel();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function fetchPreviewText(url: string, signal: AbortSignal): Promise<string> {
  return fetch(toRawUrl(url), {
    headers: { Range: `bytes=0-${String(TEXT_PREVIEW_MAX_BYTES - 1)}` },
    signal,
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    return await readLimitedText(response);
  });
}

const loadTextPreviewOnRef$ = command(
  ({ get, set }, el: HTMLElement, signal: AbortSignal) => {
    const key = el.dataset.textPreviewKey;
    const url = el.dataset.textPreviewUrl;
    if (!key || !url) {
      return;
    }
    const pageSignal = get(maybePageSignal$);
    const fetchSignal = pageSignal
      ? AbortSignal.any([signal, pageSignal])
      : signal;

    set(internalTextPreviewLoadStateByKey$, (current) => {
      const next = { ...current };
      next[key] = { status: "loading", text: "" };
      return next;
    });

    return fetchPreviewText(url, fetchSignal)
      .then((text) => {
        if (!fetchSignal.aborted) {
          set(internalTextPreviewLoadStateByKey$, (current) => {
            const next = { ...current };
            next[key] = { status: "loaded", text };
            return next;
          });
        }
      })
      .catch(() => {
        if (!fetchSignal.aborted) {
          set(internalTextPreviewLoadStateByKey$, (current) => {
            const next = { ...current };
            next[key] = { status: "error", text: "" };
            return next;
          });
        }
      });
  },
);

export const textPreviewLoaderRef$ = onRef(loadTextPreviewOnRef$);

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
