import { command } from "ccstate";

import { onRef } from "../utils.ts";

function loadThumbnail(image: HTMLImageElement): void {
  const url = image.dataset.src;
  if (url && image.getAttribute("src") !== url) {
    image.src = url;
  }
}

const PREVIEW_SETTLED_EVENT = "intro-video-preview-settled";

/** Each card releases its own visible thumbnails, independent of other cards. */
export const settleIntroVideoAvatarPreview$ = command(
  (_ctx, preview: HTMLImageElement) => {
    preview.dataset.settled = "true";
    const card = preview.closest("[data-intro-video-avatar-group]");
    card?.dispatchEvent(new Event(PREVIEW_SETTLED_EVENT));
  },
);

export const setIntroVideoAvatarThumbnailRef$ = onRef<HTMLImageElement>(
  command((_ctx, image: HTMLImageElement, signal: AbortSignal) => {
    const card = image.closest("[data-intro-video-avatar-group]");
    let visible = false;
    const release = () => {
      const preview = card?.querySelector<HTMLImageElement>(
        "[data-intro-video-avatar-preview]",
      );
      // Re-read the cover: inline look selection can replace it while loading.
      if (
        visible &&
        (!preview ||
          preview.dataset.settled === "true" ||
          (preview.complete && preview.naturalWidth > 0))
      ) {
        loadThumbnail(image);
        observer.disconnect();
        card?.removeEventListener(PREVIEW_SETTLED_EVENT, release);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => {
          return entry.isIntersecting;
        });
        release();
      },
      {
        root: image.closest("[data-intro-video-catalog-scroll]"),
      },
    );
    // IntersectionObserver also respects the horizontally clipped look strip.
    observer.observe(image);
    card?.addEventListener(PREVIEW_SETTLED_EVENT, release, { signal });
    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
  }),
);
