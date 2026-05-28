import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
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
  openDocumentLightbox$ as openDocumentLightboxModal$,
  openImageLightbox$ as openImageLightboxModal$,
  openVideoLightbox$ as openVideoLightboxModal$,
} from "./zero-attachment-chips.ts";

// ---------------------------------------------------------------------------
// Artifact sidebar — URL-routed page-level slot for previewing a single
// attachment next to the chat thread area. Gated behind
// FeatureSwitchKey.ChatArtifactSidebar; the OFF path keeps the old modal
// lightbox in place.
// ---------------------------------------------------------------------------

const ARTIFACT_QUERY_PARAM = "artifact";
const IMAGE_ID_PREFIX = "image:";

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

export const chatArtifactSidebarEnabled$ = computed((get) => {
  const features = get(featureSwitch$);
  return features[FeatureSwitchKey.ChatArtifactSidebar] ?? false;
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

const openArtifact$ = command(({ get, set }, url: string) => {
  const params = new URLSearchParams(get(searchParams$));
  params.set(ARTIFACT_QUERY_PARAM, url);
  set(updateSearchParams$, params);
});

export const closeArtifact$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (!params.has(ARTIFACT_QUERY_PARAM)) {
    return;
  }
  params.delete(ARTIFACT_QUERY_PARAM);
  set(replaceSearchParams$, params);
  set(internalArtifactFullscreen$, false);
});

export const clearArtifactPreview$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  set(internalArtifactFullscreen$, false);
  if (!params.has(ARTIFACT_QUERY_PARAM)) {
    return;
  }
  params.delete(ARTIFACT_QUERY_PARAM);
  set(replaceSearchParams$, params);
});

// ---------------------------------------------------------------------------
// Fullscreen toggle — the sidebar fills the viewport on demand. Lives in
// memory (intentionally not URL-routed) so deep links open at the default
// 50/50 size.
// ---------------------------------------------------------------------------

const internalArtifactFullscreen$ = state<boolean>(false);

export const artifactFullscreen$ = computed((get) => {
  return get(internalArtifactFullscreen$);
});

export const toggleArtifactFullscreen$ = command(({ get, set }) => {
  set(internalArtifactFullscreen$, !get(internalArtifactFullscreen$));
});

// ---------------------------------------------------------------------------
// Switch-aware open commands — the existing lightbox-open commands route
// here when the sidebar feature switch is on, so every chip click site
// participates without per-callsite branching.
// ---------------------------------------------------------------------------

export const openImageLightboxOrArtifact$ = command(
  ({ get, set }, url: string) => {
    if (get(chatArtifactSidebarEnabled$)) {
      set(openArtifact$, url);
      return;
    }
    set(openImageLightboxModal$, url);
  },
);

export const openVideoLightboxOrArtifact$ = command(
  ({ get, set }, value: { url: string; filename: string }) => {
    if (get(chatArtifactSidebarEnabled$)) {
      set(openArtifact$, value.url);
      return;
    }
    set(openVideoLightboxModal$, value);
  },
);

export const openDocumentLightboxOrArtifact$ = command(
  (
    { get, set },
    value: {
      kind: "markdown" | "text" | "json" | "csv" | "html" | "pdf";
      url: string;
      filename: string;
    },
  ) => {
    if (get(chatArtifactSidebarEnabled$)) {
      set(openArtifact$, value.url);
      return;
    }
    set(openDocumentLightboxModal$, value);
  },
);
