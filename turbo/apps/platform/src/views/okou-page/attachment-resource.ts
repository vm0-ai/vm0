import { useGet, useLastResolved } from "ccstate-react";
import { pageAttachmentResourceUrlResolver$ } from "../../signals/attachment-resource-url.ts";
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
  return useLastResolved(resolveResourceUrl(publicAttachmentUrl(url))) ?? null;
}
