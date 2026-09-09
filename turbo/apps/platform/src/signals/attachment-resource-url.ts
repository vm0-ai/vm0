import { settle } from "./utils.ts";
import { command, computed, state, type Command, type Computed } from "ccstate";
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

import { now } from "../lib/time.ts";

const RENEW_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

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

export interface AttachmentUrls {
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
  readonly expiresAt: string | null;
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
        expiresAt: response.body.expiresAt,
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
        expiresAt: response.body.expiresAt,
      };
    }
    if (!isAuthenticatedAttachmentUrl(url)) {
      // Already a public address, so it both renders and shares as-is.
      return { resourceUrl: url, shareUrl: url, expiresAt: null };
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
      expiresAt: response.body.expiresAt,
    };
  });
}

/** A request's deadline is scheduling metadata, not a second response cache. */
interface AttachmentRequest {
  readonly urls$: Computed<Promise<AttachmentUrls>>;
  readonly needsRenewal: () => boolean;
}

function createAttachmentRequest(url: string): AttachmentRequest {
  let expiresAt: number | null = null;
  let failed = false;
  const load$ = createAttachmentResourceUrl$(url);
  const urls$ = computed(async (get) => {
    const result = await settle(get(load$), get(pageSignal$));
    if (!result.ok) {
      failed = true;
      throw result.error;
    }
    failed = false;
    const urls = result.value;
    expiresAt = urls.expiresAt === null ? null : Date.parse(urls.expiresAt);
    return urls;
  });
  return {
    urls$,
    needsRenewal: () => {
      return (
        failed ||
        (expiresAt !== null && expiresAt <= now() + RENEW_BEFORE_EXPIRY_MS)
      );
    },
  };
}

interface AttachmentResource {
  readonly urls$: Computed<Promise<AttachmentUrls>>;
  readonly prepare$: Command<AttachmentRequest, []>;
}

function createAttachmentResource(url: string): AttachmentResource {
  const current$ = state(createAttachmentRequest(url));
  return {
    urls$: computed((get) => {
      return get(get(current$).urls$);
    }),
    prepare$: command(({ get, set }) => {
      const current = get(current$);
      if (!current.needsRenewal()) {
        return current;
      }
      const next = createAttachmentRequest(url);
      set(current$, next);
      return next;
    }),
  };
}

interface AttachmentResourceUrlResolver {
  (url: string): Computed<Promise<AttachmentUrls>>;
  readonly prepare$: Command<AttachmentRequest, [string]>;
}

/** Request identity and in-flight work are shared within the owning page. */
function createAttachmentResourceUrlResolver(): AttachmentResourceUrlResolver {
  const resources = new Map<string, AttachmentResource>();
  const resourceFor = (url: string): AttachmentResource => {
    let resource = resources.get(url);
    if (!resource) {
      resource = createAttachmentResource(url);
      resources.set(url, resource);
    }
    return resource;
  };
  return Object.assign(
    (url: string) => {
      return resourceFor(url).urls$;
    },
    {
      prepare$: command(({ set }, url: string) => {
        return set(resourceFor(url).prepare$);
      }),
    },
  );
}

/** A display pins one request, so renewing another display cannot replace its src. */
export interface AttachmentDisplay {
  readonly url: string;
  readonly urls$: Computed<Promise<AttachmentUrls>>;
  readonly prepare$: Command<void, []>;
  readonly retry$: Command<boolean, []>;
}

export function createAttachmentDisplay(url: string): AttachmentDisplay {
  const selected$ = state<AttachmentRequest | null>(null);
  const retried$ = state(false);
  return {
    url,
    urls$: computed((get) => {
      return get(
        get(selected$)?.urls$ ?? get(pageAttachmentResourceUrlResolver$)(url),
      );
    }),
    prepare$: command(({ get, set }) => {
      set(
        selected$,
        set(get(pageAttachmentResourceUrlResolver$).prepare$, url),
      );
      set(retried$, false);
    }),
    retry$: command(({ get, set }) => {
      const selected = get(selected$);
      if (!selected?.needsRenewal() || get(retried$)) {
        return false;
      }
      set(retried$, true);
      set(
        selected$,
        set(get(pageAttachmentResourceUrlResolver$).prepare$, url),
      );
      return true;
    }),
  };
}

export const pageAttachmentResourceUrlResolver$ = computed((get) => {
  get(pageSignal$);
  return createAttachmentResourceUrlResolver();
});

/** Called by the command that opens a preview, before React consumes its signals. */
export const prepareAttachmentDisplay$ = command(({ set }, url: string) => {
  const display = createAttachmentDisplay(url);
  set(display.prepare$);
  return display;
});

export const noAttachmentRetry$ = command(() => {
  return false;
});
