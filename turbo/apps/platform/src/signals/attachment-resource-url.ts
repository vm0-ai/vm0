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
      client.download({
        query: { file_id: fileId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    const resourceUrl = URL.createObjectURL(response.body);
    signal.addEventListener(
      "abort",
      () => {
        URL.revokeObjectURL(resourceUrl);
      },
      { once: true },
    );
    return resourceUrl;
  });
}
