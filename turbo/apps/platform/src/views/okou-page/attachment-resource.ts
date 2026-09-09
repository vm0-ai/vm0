import { useGet, useResolved } from "ccstate-react";
import {
  pageAttachmentResourceUrlResolver$,
  type AttachmentUrls,
} from "../../signals/attachment-resource-url.ts";
import { publicAttachmentUrl } from "./attachment-url";

export function useAttachmentUrls(url: string): AttachmentUrls | undefined {
  const resolveResourceUrl = useGet(pageAttachmentResourceUrlResolver$);
  return useResolved(resolveResourceUrl(publicAttachmentUrl(url)));
}

/**
 * Resolves the URL a browser element can actually load, or null while that is
 * still in flight. Persisted attachments live behind an authenticated API
 * route, and a `src` attribute on `<img>`, `<video>`, `<audio>` or `<iframe>`
 * cannot carry an Authorization header, so every preview renders from the
 * presigned object URL. Public CDN URLs resolve to themselves, so a caller does
 * not need to know which form it holds.
 */
export function useResolvedAttachmentUrl(url: string): string | null {
  return useAttachmentUrls(url)?.resourceUrl ?? null;
}

/**
 * Resolves the URL that keeps working for whoever receives it, or null when
 * there is none to offer yet. A public CDN URL resolves to itself; a private
 * artifact has no share URL until it has been explicitly published.
 */
export function useAttachmentShareUrl(url: string): string | null {
  return useAttachmentUrls(url)?.shareUrl ?? null;
}
