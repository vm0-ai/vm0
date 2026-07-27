import { command } from "ccstate";
import type { ArtifactDetail } from "@vm0/api-contracts/contracts/artifact-catalog";

import {
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "../../views/zero-page/zero-attachment-url.ts";
import {
  classifyChatAttachment,
  type BodyPreviewKind,
} from "../chat-page/parse-body-blocks.ts";
import {
  openAudioLightbox$,
  openDocumentLightbox$,
  openImageLightbox$,
  openVideoLightbox$,
} from "../zero-page/zero-attachment-chips.ts";
import { createArtifactCatalogSignals } from "./create-artifact-catalog-signals.ts";

/**
 * The `/artifacts` page instance over the whole org catalog. Chat thread
 * sidebars create their own thread-scoped instances.
 */
const pageCatalog = createArtifactCatalogSignals();

export const selectedArtifactCatalogKind$ = pageCatalog.selectedKind$;

export const setArtifactCatalogKind$ = pageCatalog.setKind$;

export const reloadArtifactCatalog$ = pageCatalog.reload$;

export const artifactCatalog$ = pageCatalog.catalog$;

export const loadMoreArtifactCatalog$ = pageCatalog.loadMore$;

export const subscribeArtifactCatalogChanged$ =
  pageCatalog.subscribeCatalogChanged$;

export function artifactDetailPreview(detail: ArtifactDetail): {
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
    set(pageCatalog.selectArtifact$, artifactId);
    const detail = await get(pageCatalog.selectedArtifactDetail$);
    signal.throwIfAborted();
    if (!detail) {
      return;
    }

    const preview = artifactDetailPreview(detail);
    const base = {
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
    if (preview.kind === "file") {
      await downloadAttachmentUrl(preview.url, signal, preview.filename);
      signal.throwIfAborted();
      return;
    }
    set(openDocumentLightbox$, { ...base, kind: preview.kind });
  },
);
