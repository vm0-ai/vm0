import { computed, type Computed } from "ccstate";
import { zeroWebFilesContract } from "@vm0/api-contracts/contracts/zero-web-files";
import { accept } from "../lib/accept.ts";
import { pageSignal$ } from "./page-signal.ts";
import { resolveApiBase } from "./api-base.ts";
import { zeroClient$ } from "./api-client.ts";

const AUTHENTICATED_FILE_PATH = "/api/zero/web/download-file";

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
 * API route, and `<img src>` cannot carry an Authorization header. Exchange the
 * canonical API URL for a short-lived presigned object URL the browser can load
 * on its own; the API still runs the ownership check before signing.
 */
export function createAttachmentResourceUrl$(
  url: string,
): Computed<Promise<string>> {
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
      [200, 404],
      signal,
    );
    // A newly promoted app can briefly reach an API build from before this
    // additive route existed. Surface: old web clients, ~2 days observed
    // maximum exposure. Falling back to the canonical URL keeps the existing
    // broken-image placeholder instead of raising one error toast per
    // attachment; the same branch also covers a genuinely deleted file.
    // Remove once this API version is outside the production rollback window;
    // follow-up #25828.
    if (response.status === 404) {
      return url;
    }
    return response.body.url;
  });
}
