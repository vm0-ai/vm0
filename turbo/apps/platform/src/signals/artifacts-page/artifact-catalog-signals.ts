import { command, computed, state } from "ccstate";
import {
  artifactCatalogContract,
  type ArtifactCatalogKind,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";

import { accept } from "../../lib/accept.ts";
import { publicAttachmentUrl } from "../../views/zero-page/zero-attachment-url.ts";
import { zeroClient$ } from "../api-client.ts";
import {
  classifyChatAttachment,
  type BodyPreviewKind,
} from "../chat-page/parse-body-blocks.ts";
import { setAblyLoop$ } from "../realtime.ts";
import {
  openAudioLightbox$,
  openDocumentLightbox$,
  openImageLightbox$,
  openVideoLightbox$,
} from "../zero-page/zero-attachment-chips.ts";

// First screen and every scroll step request the same page size. The server
// orders by `(createdAt, id)` and never reorders on update, so a cursor stays
// valid for the whole scroll session.
const ARTIFACT_CATALOG_PAGE_SIZE = 60;

interface ArtifactCatalogPage {
  readonly artifacts: readonly ArtifactSummary[];
  readonly nextCursor: string | null;
}

const internalArtifactCatalogKind$ = state<ArtifactCatalogKind | null>(null);
const internalArtifactCatalogReload$ = state(0);
const internalArtifactCatalogPages$ = state<readonly ArtifactCatalogPage[]>([]);
// Cursors already handed to the server. Scroll events fire faster than a page
// resolves, so this keeps one request per cursor without a loading flag.
const internalArtifactCatalogFetchedCursors$ = state<ReadonlySet<string>>(
  new Set(),
);
const internalSelectedArtifactId$ = state<string | null>(null);

export const selectedArtifactCatalogKind$ = computed((get) => {
  return get(internalArtifactCatalogKind$);
});

export const selectedArtifactId$ = computed((get) => {
  return get(internalSelectedArtifactId$);
});

const resetArtifactCatalogPages$ = command(({ set }) => {
  set(internalArtifactCatalogPages$, []);
  set(internalArtifactCatalogFetchedCursors$, new Set());
});

export const setArtifactCatalogKind$ = command(
  ({ set }, kind: ArtifactCatalogKind | null) => {
    set(internalArtifactCatalogKind$, kind);
    set(resetArtifactCatalogPages$);
  },
);

/**
 * Re-read the first page. Later pages are dropped rather than re-fetched: new
 * artifacts always land at the head, so the first page is the only one that can
 * have changed.
 */
export const reloadArtifactCatalog$ = command(({ set }) => {
  set(resetArtifactCatalogPages$);
  set(internalArtifactCatalogReload$, (version) => {
    return version + 1;
  });
});

const firstArtifactCatalogPage$ = computed(
  async (get, { signal }): Promise<ArtifactCatalogPage> => {
    get(internalArtifactCatalogReload$);
    const kind = get(internalArtifactCatalogKind$);
    const client = get(zeroClient$)(artifactCatalogContract);
    const result = await accept(
      client.list({
        query: {
          limit: ARTIFACT_CATALOG_PAGE_SIZE,
          ...(kind ? { kind } : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    return result.body;
  },
);

/**
 * Everything loaded so far, in server order. Reading this triggers the first
 * page fetch; `loadMoreArtifactCatalog$` appends the rest.
 */
export const artifactCatalog$ = computed(
  async (get): Promise<ArtifactCatalogPage> => {
    const firstPage = await get(firstArtifactCatalogPage$);
    const appendedPages = get(internalArtifactCatalogPages$);
    const lastPage = appendedPages.at(-1) ?? firstPage;
    return {
      artifacts: [
        ...firstPage.artifacts,
        ...appendedPages.flatMap((page) => {
          return page.artifacts;
        }),
      ],
      nextCursor: lastPage.nextCursor,
    };
  },
);

export const loadMoreArtifactCatalog$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const loaded = await get(artifactCatalog$);
    signal.throwIfAborted();
    const cursor = loaded.nextCursor;
    if (!cursor || get(internalArtifactCatalogFetchedCursors$).has(cursor)) {
      return;
    }
    set(internalArtifactCatalogFetchedCursors$, (cursors) => {
      return new Set([...cursors, cursor]);
    });

    const kind = get(internalArtifactCatalogKind$);
    const client = get(zeroClient$)(artifactCatalogContract);
    const result = await accept(
      client.list({
        query: {
          limit: ARTIFACT_CATALOG_PAGE_SIZE,
          cursor,
          ...(kind ? { kind } : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(internalArtifactCatalogPages$, (pages) => {
      return [...pages, result.body];
    });
  },
);

export const selectArtifact$ = command(({ set }, artifactId: string | null) => {
  set(internalSelectedArtifactId$, artifactId);
});

/**
 * Kind-specific detail for the opened card. Null while nothing is selected, so
 * the list never pays for detail queries it does not render.
 */
export const selectedArtifactDetail$ = computed(
  async (get, { signal }): Promise<ArtifactDetail | null> => {
    const artifactId = get(internalSelectedArtifactId$);
    if (!artifactId) {
      return null;
    }
    const client = get(zeroClient$)(artifactCatalogContract);
    const result = await accept(
      client.get({
        params: { artifactId },
        fetchOptions: { signal },
      }),
      [200, 404],
      signal,
    );
    return result.status === 404 ? null : result.body;
  },
);

function artifactDetailPreview(detail: ArtifactDetail): {
  readonly kind: BodyPreviewKind;
  readonly url: string;
  readonly filename: string;
} {
  if (detail.kind === "hosted-site" || detail.kind === "presentation") {
    return { kind: "html", url: detail.site.url, filename: detail.title };
  }
  return {
    kind: classifyChatAttachment({
      filename: detail.file.filename,
      url: detail.file.url,
      contentType: detail.file.contentType,
    }),
    url: publicAttachmentUrl(detail.file.url),
    filename: detail.file.filename,
  };
}

/**
 * Open a card. The kind entity is fetched here rather than with the list, so
 * browsing the grid never pays for detail queries.
 */
export const openArtifact$ = command(
  async ({ get, set }, artifactId: string, signal: AbortSignal) => {
    set(selectArtifact$, artifactId);
    const detail = await get(selectedArtifactDetail$);
    signal.throwIfAborted();
    if (!detail) {
      return;
    }

    const preview = artifactDetailPreview(detail);
    const base = {
      editAvailable: false,
      filename: preview.filename,
      showSizeInSubtitle: false,
      splitViewAvailable: false,
      url: preview.url,
    };
    if (preview.kind === "image") {
      set(openImageLightbox$, base);
      return;
    }
    if (preview.kind === "video") {
      set(openVideoLightbox$, base);
      return;
    }
    if (preview.kind === "audio") {
      set(openAudioLightbox$, base);
      return;
    }
    if (preview.kind !== "file") {
      set(openDocumentLightbox$, { ...base, kind: preview.kind });
    }
  },
);

/**
 * Reload the first page whenever the catalog changes for this user.
 */
export const subscribeArtifactCatalogChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onChanged$ = command(({ set }) => {
      set(reloadArtifactCatalog$);
      return false;
    });
    await set(
      setAblyLoop$,
      { topic: "artifactCatalogChanged", loopCommand$: onChanged$ },
      signal,
    );
  },
);
