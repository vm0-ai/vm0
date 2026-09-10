import { computed, type Computed } from "ccstate";
import { publicAttachmentUrl } from "../views/okou-page/attachment-url.ts";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { privateHostedDeploymentId } from "@okouai/core/private-hosted-artifact";
import { accept } from "../lib/accept.ts";
import { pageSignal$ } from "./page-signal.ts";
import { resolveApiBase } from "./api-base.ts";
import { apiClient$ } from "./api-client.ts";

const AUTHENTICATED_FILE_PATH = "/api/web/download-file";

export function isAuthenticatedAttachmentUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  return (
    parsed.origin === new URL(resolveApiBase()).origin &&
    parsed.pathname === AUTHENTICATED_FILE_PATH
  );
}

interface AttachmentUrls {
  /**
   * URL this browser can load right now. Presigned for a private attachment,
   * so it expires and grants access only to that object.
   */
  readonly resourceUrl: string;
  /**
   * URL that still works for whoever receives it. Never the canonical API URL:
   * that one answers only to the owner's credentials, so a recipient gets a 401
   * instead of the file. Null until a private artifact is published.
   */
  readonly shareUrl: string | null;
}

export function createAttachmentResourceUrl$(url: string) {
  const urls$ = createAttachmentUrls$(url);
  return computed(async (get) => {
    return (await get(urls$)).resourceUrl;
  });
}

export function createAttachmentPreviewSignals(url: string) {
  const urls$ = createAttachmentUrls$(url);
  return {
    resourceUrl$: computed(async (get) => {
      return (await get(urls$)).resourceUrl;
    }),
    shareUrl$: computed(async (get) => {
      return (await get(urls$)).shareUrl;
    }),
  };
}

/**
 * Persisted chat attachments live behind an authenticated API route, and a bare
 * `src` attribute cannot carry an Authorization header. Exchange the canonical
 * API URL for the URLs the browser can actually use; the API still runs the
 * ownership check before answering.
 */
export function createAttachmentUrls$(
  inputUrl: string,
): Computed<Promise<AttachmentUrls>> {
  const url = publicAttachmentUrl(inputUrl);
  // eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
  return computed(async (get) => {
    const reference = parseArtifactReference(url, location.origin);
    if (reference) {
      const signal = get(pageSignal$);
      const response = await accept(
        get(apiClient$)(artifactReferencesContract).resolve({
          params: { reference: `${reference.hash}${reference.extension}` },
          fetchOptions: { signal, cache: "no-store" },
        }),
        [200],
        signal,
      );
      const resourceUrl = new URL(response.body.url);
      resourceUrl.hash = reference.fragment;
      return {
        resourceUrl: resourceUrl.href,
        shareUrl: null,
      };
    }
    const deploymentId = privateHostedDeploymentId(url, resolveApiBase());
    if (deploymentId) {
      const signal = get(pageSignal$);
      const response = await accept(
        get(apiClient$)(hostContract).privatePreview({
          params: { deploymentId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      const resourceUrl = new URL(response.body.url);
      resourceUrl.hash = new URL(url).hash;
      return {
        resourceUrl: resourceUrl.href,
        shareUrl: null,
      };
    }
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
      shareUrl: response.body.publicUrl,
    };
  });
}
