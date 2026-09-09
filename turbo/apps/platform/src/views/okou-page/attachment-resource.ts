import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { SyntheticEvent } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  pageAttachmentResourceUrlResolver$,
  noAttachmentRetry$,
  type AttachmentUrls,
  type AttachmentDisplay,
} from "../../signals/attachment-resource-url.ts";
import { publicAttachmentUrl } from "./attachment-url";

export function useAttachmentUrls(
  url: string,
  providedDisplay?: AttachmentDisplay,
): AttachmentUrls | undefined {
  const resolveResourceUrl = useGet(pageAttachmentResourceUrlResolver$);
  const display = providedDisplay;
  return useLastResolved(
    display?.url === url
      ? display.urls$
      : resolveResourceUrl(publicAttachmentUrl(url)),
  );
}

/**
 * Resolves the URL a browser element can actually load, or null while that is
 * still in flight. Persisted attachments live behind an authenticated API
 * route, and a `src` attribute on `<img>`, `<video>`, `<audio>` or `<iframe>`
 * cannot carry an Authorization header, so every preview renders from the
 * presigned object URL. Public CDN URLs resolve to themselves, so a caller does
 * not need to know which form it holds.
 */
export function useResolvedAttachmentUrl(
  url: string,
  display?: AttachmentDisplay,
): string | null {
  return useAttachmentUrls(url, display)?.resourceUrl ?? null;
}

/** DOM failures renew an expired credential once for this display. */
export function useAttachmentLoadError(providedDisplay?: AttachmentDisplay) {
  const display = providedDisplay;
  return useSet(display?.retry$ ?? noAttachmentRetry$);
}

/** Keep the media element and its playback position across an expired Range read. */
export function useAttachmentMediaError(display?: AttachmentDisplay) {
  const retry = useAttachmentLoadError(display);
  const signal = useGet(pageSignal$);
  return (event: SyntheticEvent<HTMLMediaElement>) => {
    const media = event.currentTarget;
    const currentTime = media.currentTime;
    const paused = media.paused;
    if (!retry()) {
      return;
    }
    media.addEventListener(
      "loadedmetadata",
      () => {
        media.currentTime = currentTime;
        if (paused) {
          media.pause();
        } else {
          detach(media.play(), Reason.DomCallback);
        }
      },
      { once: true, signal },
    );
  };
}
