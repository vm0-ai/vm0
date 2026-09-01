import { useGet, useLastResolved } from "ccstate-react";
import {
  isAuthenticatedAttachmentUrl,
  pageAttachmentResourceUrlResolver$,
} from "../../signals/attachment-resource-url.ts";
import { publicAttachmentUrl } from "./attachment-url";

/**
 * Resolves the URL a browser element can actually load, or null while that is
 * still in flight. Persisted attachments live behind an authenticated API
 * route, and a `src` attribute on `<img>`, `<video>`, `<audio>` or `<iframe>`
 * cannot carry an Authorization header, so every preview renders from the
 * presigned object URL. Public CDN URLs resolve to themselves, so a caller does
 * not need to know which form it holds.
 */
export function useResolvedAttachmentUrl(url: string): string | null {
  const resolveResourceUrl = useGet(pageAttachmentResourceUrlResolver$);
  return (
    useLastResolved(resolveResourceUrl(publicAttachmentUrl(url)))
      ?.resourceUrl ?? null
  );
}

/**
 * Resolves the URL that keeps working for whoever receives it, or null when
 * there is none to offer yet. A public CDN URL is already that address, so it
 * answers without a round trip; a private attachment has to ask the API, which
 * only then reveals the public address of the object it just authorized.
 */
export function useAttachmentShareUrl(url: string): string | null {
  const normalizedUrl = publicAttachmentUrl(url);
  const resolveResourceUrl = useGet(pageAttachmentResourceUrlResolver$);
  const resolved = useLastResolved(resolveResourceUrl(normalizedUrl));
  return isAuthenticatedAttachmentUrl(normalizedUrl)
    ? (resolved?.shareUrl ?? null)
    : normalizedUrl;
}
