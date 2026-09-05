import { command } from "ccstate";

import { onRef } from "../utils.ts";

function loadThumbnail(image: HTMLImageElement): void {
  const url = image.dataset.src;
  if (url && image.getAttribute("src") !== url) {
    image.src = url;
  }
}

/** Release a card's secondary images only after its main preview settles. */
export const settleIntroVideoAvatarPreview$ = command(
  (_ctx, preview: HTMLImageElement) => {
    preview.dataset.settled = "true";
    const card = preview.closest("[data-intro-video-avatar-group]");
    for (const image of card?.querySelectorAll<HTMLImageElement>(
      "[data-intro-video-avatar-thumbnail]",
    ) ?? []) {
      loadThumbnail(image);
    }
  },
);

export const setIntroVideoAvatarThumbnailRef$ = onRef<HTMLImageElement>(
  command((_ctx, image: HTMLImageElement) => {
    const preview = image
      .closest("[data-intro-video-avatar-group]")
      ?.querySelector<HTMLImageElement>("[data-intro-video-avatar-preview]");
    // Provider previews are optional. A missing/failed cover must not prevent
    // browsing other looks. Also handle cached covers and later catalog pages,
    // whose new thumbnails mount without another cover load event.
    if (
      !preview ||
      preview.dataset.settled === "true" ||
      (preview.complete && preview.naturalWidth > 0)
    ) {
      loadThumbnail(image);
    }
  }),
);
