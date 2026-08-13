import { computed, type Computed } from "ccstate";
import { zeroWebFilesContract } from "@okouai/api-contracts/contracts/zero-web-files";
import { accept } from "../lib/accept.ts";
import { pageSignal$ } from "./page-signal.ts";
import { resolveApiBase } from "./api-base.ts";
import { zeroClient$ } from "./api-client.ts";

const AUTHENTICATED_FILE_PATH = "/api/okou/web/download-file";

function isAuthenticatedAttachmentUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  return (
    parsed.origin === new URL(resolveApiBase()).origin &&
    parsed.pathname === AUTHENTICATED_FILE_PATH
  );
}

/**
 * Persisted chat attachments live in a private bucket behind an authenticated
 * API route, and a bare `src` attribute cannot carry an Authorization header.
 * Exchange the canonical API URL for a short-lived presigned object URL the
 * browser can load on its own; the API still runs the ownership check before
 * signing.
 */
function createAttachmentResourceUrl$(url: string): Computed<Promise<string>> {
  return computed(async (get) => {
    if (!isAuthenticatedAttachmentUrl(url)) {
      return url;
    }

    const sourceUrl = new URL(url);
    const fileId = sourceUrl.searchParams.get("file_id");
    if (!fileId) {
      throw new Error("Authenticated attachment URL is missing file_id");
    }
    const signal = get(pageSignal$);
    const client = get(zeroClient$)(zeroWebFilesContract);
    const response = await accept(
      client.fileUrl({
        query: { file_id: fileId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    return response.body.url;
  });
}

export type AttachmentResourceUrlResolver = (
  url: string,
) => Computed<Promise<string>>;

/**
 * Create the URL join owned by one thread or page. The returned map is private:
 * consumers only receive the resolved item's computed, never the keyed store.
 */
export function createAttachmentResourceUrlResolver(): AttachmentResourceUrlResolver {
  const resourceUrlByUrl = new Map<string, Computed<Promise<string>>>();
  return (url: string): Computed<Promise<string>> => {
    const existing = resourceUrlByUrl.get(url);
    if (existing) {
      return existing;
    }
    const resourceUrl$ = createAttachmentResourceUrl$(url);
    resourceUrlByUrl.set(url, resourceUrl$);
    return resourceUrl$;
  };
}

/**
 * Preview components that do not already receive thread-owned signals share a
 * resolver for the current page. Replacing the page signal replaces the whole
 * resolver, so URLs from a previous page are no longer retained.
 */
export const pageAttachmentResourceUrlResolver$ = computed((get) => {
  get(pageSignal$);
  return createAttachmentResourceUrlResolver();
});
