import { computed, type Computed } from "ccstate";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { accept } from "../lib/accept.ts";
import { pageSignal$ } from "./page-signal.ts";
import { resolveApiBase } from "./api-base.ts";
import { apiClient$ } from "./api-client.ts";

const AUTHENTICATED_FILE_PATH = "/api/web/download-file";

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

export interface AttachmentUrls {
  /**
   * URL this browser can load right now. Presigned for a private attachment,
   * so it expires and is scoped to the viewer.
   */
  readonly resourceUrl: string;
  /**
   * URL that still works for whoever receives it, or null when the attachment
   * has no such address. Never the canonical API URL: that one answers only to
   * the owner's credentials, so a recipient gets a 401 instead of the file.
   */
  readonly shareUrl: string | null;
}

/**
 * Persisted chat attachments live behind an authenticated API route, and a bare
 * `src` attribute cannot carry an Authorization header. Exchange the canonical
 * API URL for the URLs the browser can actually use; the API still runs the
 * ownership check before answering.
 */
function createAttachmentResourceUrl$(
  url: string,
): Computed<Promise<AttachmentUrls>> {
  return computed(async (get) => {
    if (!isAuthenticatedAttachmentUrl(url)) {
      // Already a public address, so it both renders and shares as-is.
      return { resourceUrl: url, shareUrl: url };
    }

    const sourceUrl = new URL(url);
    const fileId = sourceUrl.searchParams.get("file_id");
    if (!fileId) {
      throw new Error("Authenticated attachment URL is missing file_id");
    }
    const signal = get(pageSignal$);
    const client = get(apiClient$)(webFilesContract);
    const response = await accept(
      client.fileUrl({
        query: { file_id: fileId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    return {
      resourceUrl: response.body.url,
      // Rollout fallback, surface new web/app -> old API: a newly promoted app
      // can reach an API deployed before `publicUrl` existed. Report no share
      // URL rather than a presigned one that expires under the recipient.
      // Remove once that API is no longer serving and is no longer retained as
      // a rollback target; follow-up #30847.
      shareUrl: response.body.publicUrl ?? null,
    };
  });
}

export type AttachmentResourceUrlResolver = (
  url: string,
) => Computed<Promise<AttachmentUrls>>;

/**
 * Create the URL join owned by one thread or page. The returned map is private:
 * consumers only receive the resolved item's computed, never the keyed store.
 */
export function createAttachmentResourceUrlResolver(): AttachmentResourceUrlResolver {
  const resourceUrlByUrl = new Map<string, Computed<Promise<AttachmentUrls>>>();
  return (url: string): Computed<Promise<AttachmentUrls>> => {
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
