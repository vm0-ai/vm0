import { command, computed, state } from "ccstate";
import {
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import {
  classifyChatAttachment,
  previewAttachmentFromUrl,
} from "../chat-page/parse-body-blocks.ts";
import {
  type AttachmentArtifactMetadata,
  openAudioLightbox$ as openAudioLightboxModal$,
  openDocumentLightbox$ as openDocumentLightboxModal$,
  openImageLightbox$ as openImageLightboxModal$,
  openVideoLightbox$ as openVideoLightboxModal$,
} from "./zero-attachment-chips.ts";

// ---------------------------------------------------------------------------
// Artifact sidebar — URL-routed page-level slot for previewing a single
// attachment next to the chat thread area.
//
// Sidebar state lives in search params: `?artifacts=<threadId>` opens the
// artifact inbox, `?artifact=<url>` opens a detail preview, and
// `?artifact-fullscreen=1` expands whichever artifact surface is active.
// There is no in-memory state — opening is a search-param write, closing is a
// search-param delete, and components read pure computeds over `searchParams$`.
// ---------------------------------------------------------------------------

const ARTIFACT_QUERY_PARAM = "artifact";
const ARTIFACT_INBOX_QUERY_PARAM = "artifacts";
const ARTIFACT_FULLSCREEN_PARAM = "artifact-fullscreen";
const PRESENTATION_EDITOR_QUERY_PARAM = "presentation-editor";
const IMAGE_ID_PREFIX = "image:";

export type ArtifactInboxSection = "all" | "media" | "docs" | "sites";

const internalArtifactInboxSection$ = state<ArtifactInboxSection>("all");
const internalArtifactInboxQuery$ = state("");
const internalArtifactInboxSearchOpen$ = state(false);

export type ArtifactPreviewKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "file";

export type ArtifactRef =
  | {
      source: "url";
      url: string;
      kind: ArtifactPreviewKind;
      filename: string;
    }
  | {
      source: "image-id";
      imageId: string;
    };

function decodeArtifactParam(value: string): ArtifactRef | null {
  if (value.startsWith(IMAGE_ID_PREFIX)) {
    const imageId = value.slice(IMAGE_ID_PREFIX.length);
    if (!imageId) {
      return null;
    }
    return { source: "image-id", imageId };
  }
  return null;
}

export const currentArtifactInboxThreadId$ = computed((get) => {
  return get(searchParams$).get(ARTIFACT_INBOX_QUERY_PARAM);
});

export const artifactInboxSection$ = computed((get) => {
  return get(internalArtifactInboxSection$);
});

export const artifactInboxQuery$ = computed((get) => {
  return get(internalArtifactInboxQuery$);
});

export const artifactInboxSearchOpen$ = computed((get) => {
  return get(internalArtifactInboxSearchOpen$);
});

// The URL alone is the source of truth: kind + filename are derived from
// the URL itself via previewAttachmentFromUrl, so deep-linking or refreshing
// the page re-renders the right body without any in-memory metadata cache.
// Reusing previewAttachmentFromUrl keeps hosted-site URLs (e.g.
// *.sites.vm0.io) classified as html, matching how the chat body renders
// them.
export const currentArtifactRef$ = computed<ArtifactRef | null>((get) => {
  const params = get(searchParams$);
  const raw = params.get(ARTIFACT_QUERY_PARAM);
  if (!raw) {
    return null;
  }
  if (raw.startsWith(IMAGE_ID_PREFIX)) {
    return decodeArtifactParam(raw);
  }
  const attachment = previewAttachmentFromUrl(raw);
  const kind = classifyChatAttachment(attachment);
  return { source: "url", url: raw, kind, filename: attachment.filename };
});

export const currentPresentationEditorUrl$ = computed((get) => {
  return get(searchParams$).get(PRESENTATION_EDITOR_QUERY_PARAM);
});

export const openArtifactSidebarPreview$ = command(
  ({ get, set }, url: string) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(ARTIFACT_QUERY_PARAM, url);
    params.delete(ARTIFACT_INBOX_QUERY_PARAM);
    params.delete(ARTIFACT_FULLSCREEN_PARAM);
    set(updateSearchParams$, params);
  },
);

export const openPresentationEditor$ = command(({ get, set }, url: string) => {
  const params = new URLSearchParams(get(searchParams$));
  params.set(PRESENTATION_EDITOR_QUERY_PARAM, url);
  params.set(ARTIFACT_FULLSCREEN_PARAM, "1");
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_INBOX_QUERY_PARAM);
  set(updateSearchParams$, params);
});

export const closePresentationEditor$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (!params.has(PRESENTATION_EDITOR_QUERY_PARAM)) {
    return;
  }
  params.delete(PRESENTATION_EDITOR_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  set(replaceSearchParams$, params);
});

export const openArtifactInbox$ = command(({ get, set }, threadId: string) => {
  const params = new URLSearchParams(get(searchParams$));
  params.set(ARTIFACT_INBOX_QUERY_PARAM, threadId);
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  set(internalArtifactInboxSection$, "all");
  set(internalArtifactInboxQuery$, "");
  set(internalArtifactInboxSearchOpen$, false);
  set(updateSearchParams$, params);
});

export const setArtifactInboxSection$ = command(
  ({ set }, value: ArtifactInboxSection) => {
    set(internalArtifactInboxSection$, value);
  },
);

export const setArtifactInboxQuery$ = command(({ set }, value: string) => {
  set(internalArtifactInboxQuery$, value);
});

export const toggleArtifactInboxSearch$ = command(({ get, set }) => {
  const nextOpen = !get(internalArtifactInboxSearchOpen$);
  set(internalArtifactInboxSearchOpen$, nextOpen);
  if (!nextOpen) {
    set(internalArtifactInboxQuery$, "");
  }
});

export const openArtifactFromInbox$ = command(
  ({ get, set }, args: { threadId: string; url: string }) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(ARTIFACT_INBOX_QUERY_PARAM, args.threadId);
    params.set(ARTIFACT_QUERY_PARAM, args.url);
    params.delete(ARTIFACT_FULLSCREEN_PARAM);
    set(updateSearchParams$, params);
  },
);

export const backToArtifactInbox$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  set(replaceSearchParams$, params);
});

export const closeArtifact$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (
    !params.has(ARTIFACT_QUERY_PARAM) &&
    !params.has(ARTIFACT_INBOX_QUERY_PARAM) &&
    !params.has(ARTIFACT_FULLSCREEN_PARAM)
  ) {
    return;
  }
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_INBOX_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  params.delete(PRESENTATION_EDITOR_QUERY_PARAM);
  set(replaceSearchParams$, params);
});

export const clearArtifactPreview$ = command(({ set }) => {
  set(closeArtifact$);
});

export const artifactFullscreen$ = computed((get) => {
  return get(searchParams$).get(ARTIFACT_FULLSCREEN_PARAM) === "1";
});

export const toggleArtifactFullscreen$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (params.get(ARTIFACT_FULLSCREEN_PARAM) === "1") {
    params.delete(ARTIFACT_FULLSCREEN_PARAM);
  } else {
    params.set(ARTIFACT_FULLSCREEN_PARAM, "1");
  }
  set(updateSearchParams$, params);
});

// ---------------------------------------------------------------------------
// Attachment preview clicks still open the modal lightbox. Moving into the
// artifact sidebar is an explicit lightbox action so chat previews do not jump
// directly into split view.
// ---------------------------------------------------------------------------

export const openImageLightboxOrArtifact$ = command(
  (
    { set },
    value:
      | string
      | {
          url: string;
          filename?: string;
          artifact?: AttachmentArtifactMetadata;
        },
  ) => {
    set(openImageLightboxModal$, value);
  },
);

export const openVideoLightboxOrArtifact$ = command(
  (
    { set },
    value: {
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
    },
  ) => {
    set(openVideoLightboxModal$, value);
  },
);

export const openAudioLightboxOrArtifact$ = command(
  (
    { set },
    value: {
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
    },
  ) => {
    set(openAudioLightboxModal$, value);
  },
);

export const openDocumentLightboxOrArtifact$ = command(
  (
    { set },
    value: {
      kind: "markdown" | "text" | "json" | "csv" | "html" | "pdf";
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
    },
  ) => {
    set(openDocumentLightboxModal$, value);
  },
);
