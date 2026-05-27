import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
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

interface ArtifactOpenInput {
  url: string;
  kind: ArtifactPreviewKind;
  filename: string;
}

function encodeArtifactParam(input: ArtifactOpenInput): string {
  return input.url;
}

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

// Open metadata that callers pass alongside the URL so the sidebar knows the
// filename + kind without having to re-classify from a bare URL. Kept in
// memory because the URL only carries the reference.
interface ArtifactOpenMetadata {
  filename: string;
  kind: ArtifactPreviewKind;
}

const artifactOpenMetadataByUrl$ = state<
  ReadonlyMap<string, ArtifactOpenMetadata>
>(new Map());

const rememberArtifactMetadata$ = command(
  ({ get, set }, input: ArtifactOpenInput) => {
    const current = get(artifactOpenMetadataByUrl$);
    const existing = current.get(input.url);
    if (
      existing &&
      existing.filename === input.filename &&
      existing.kind === input.kind
    ) {
      return;
    }
    const next = new Map(current);
    next.set(input.url, { filename: input.filename, kind: input.kind });
    set(artifactOpenMetadataByUrl$, next);
  },
);

export const chatArtifactSidebarEnabled$ = computed((get) => {
  const features = get(featureSwitch$);
  return features[FeatureSwitchKey.ChatArtifactSidebar] ?? false;
});

export const currentArtifactRef$ = computed<ArtifactRef | null>((get) => {
  const params = get(searchParams$);
  const raw = params.get(ARTIFACT_QUERY_PARAM);
  if (!raw) {
    return null;
  }
  if (raw.startsWith(IMAGE_ID_PREFIX)) {
    return decodeArtifactParam(raw);
  }
  const metadata = get(artifactOpenMetadataByUrl$).get(raw);
  return {
    source: "url",
    url: raw,
    kind: metadata?.kind ?? "file",
    filename: metadata?.filename ?? filenameFromUrl(raw),
  };
});

function filenameFromUrl(url: string): string {
  const cleaned = url.split("?")[0].split("#")[0];
  const last = cleaned.split("/").pop();
  return last && last.length > 0 ? last : "file";
}

export const openArtifact$ = command(
  ({ get, set }, input: ArtifactOpenInput) => {
    set(rememberArtifactMetadata$, input);
    const params = new URLSearchParams(get(searchParams$));
    params.set(ARTIFACT_QUERY_PARAM, encodeArtifactParam(input));
    set(updateSearchParams$, params);
  },
);

export const closeArtifact$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (!params.has(ARTIFACT_QUERY_PARAM)) {
    return;
  }
  params.delete(ARTIFACT_QUERY_PARAM);
  set(replaceSearchParams$, params);
  set(internalArtifactFullscreen$, false);
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
      set(openArtifact$, {
        url,
        kind: "image",
        filename: filenameFromUrl(url),
      });
      return;
    }
    set(openImageLightboxModal$, url);
  },
);

export const openVideoLightboxOrArtifact$ = command(
  ({ get, set }, value: { url: string; filename: string }) => {
    if (get(chatArtifactSidebarEnabled$)) {
      set(openArtifact$, {
        url: value.url,
        kind: "video",
        filename: value.filename,
      });
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
      set(openArtifact$, {
        url: value.url,
        kind: value.kind,
        filename: value.filename,
      });
      return;
    }
    set(openDocumentLightboxModal$, value);
  },
);
