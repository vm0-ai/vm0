import { command, computed, state } from "ccstate";
import { openArtifactInOpenSidebar$ } from "../chat-page/thread-sidebar-coordinator.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
  type TextPreviewComputed,
  type TextPreviewKind,
} from "../text-preview.ts";
import { onRef } from "../utils.ts";

// ---------------------------------------------------------------------------
// Lightbox state — tracks which attachment is open in the global preview UI
// ---------------------------------------------------------------------------

const LIGHTBOX_DIALOG_EXIT_DURATION_MS = 180;

export type AttachmentArtifactMetadata = {
  readonly agentId?: string | null;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly contentType: string;
  readonly createdAt: string;
  readonly fileId: string;
  readonly filename: string;
  readonly googleDriveDisconnected: boolean;
  readonly googleDriveSynced: boolean;
  readonly onSyncSuccess?: () => void;
  readonly runId: string;
  readonly size: number;
  readonly threadId: string;
};

interface AttachmentDocumentLightboxBase {
  readonly url: string;
  readonly filename: string;
  readonly artifact?: AttachmentArtifactMetadata;
  readonly shareAvailable?: boolean;
  readonly showSizeInSubtitle?: boolean;
  readonly splitViewAvailable?: boolean;
}

type AttachmentTextDocumentLightboxInput = AttachmentDocumentLightboxBase & {
  readonly kind: TextPreviewKind;
  readonly text$?: TextPreviewComputed;
};

type AttachmentFramedDocumentLightboxInput = AttachmentDocumentLightboxBase & {
  readonly kind: "html" | "pdf";
};

type AttachmentDocumentLightboxInput =
  | AttachmentTextDocumentLightboxInput
  | AttachmentFramedDocumentLightboxInput;

export type AttachmentDocumentLightboxState =
  | (AttachmentDocumentLightboxBase & {
      readonly kind: TextPreviewKind;
      readonly text$: TextPreviewComputed;
    })
  | AttachmentFramedDocumentLightboxInput;

function isAttachmentTextDocumentLightboxInput(
  value: AttachmentDocumentLightboxInput,
): value is AttachmentTextDocumentLightboxInput {
  return isTextPreviewKind(value.kind);
}

export type AttachmentLightboxState =
  | {
      kind: "image";
      url: string;
      filename?: string;
      threadId?: string;
      artifact?: AttachmentArtifactMetadata;
      shareAvailable?: boolean;
      showSizeInSubtitle?: boolean;
      splitViewAvailable?: boolean;
    }
  | AttachmentDocumentLightboxState
  | {
      kind: "audio" | "video";
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
      shareAvailable?: boolean;
      showSizeInSubtitle?: boolean;
      splitViewAvailable?: boolean;
    };

const internalLightboxState$ = state<AttachmentLightboxState | null>(null);
const internalLightboxDialogVisible$ = state(false);
const internalLightboxDialogFullscreen$ = state(false);
const internalLightboxDialogCloseToken$ = state(0);

export const lightboxUrl$ = computed((get) => {
  return get(internalLightboxState$);
});

export const lightboxDialogVisible$ = computed((get) => {
  return get(internalLightboxDialogVisible$);
});

export const lightboxDialogFullscreen$ = computed((get) => {
  return get(internalLightboxDialogFullscreen$);
});

export const toggleLightboxDialogFullscreen$ = command(({ get, set }) => {
  set(
    internalLightboxDialogFullscreen$,
    !get(internalLightboxDialogFullscreen$),
  );
});

const closeLightboxForDialogExitToken$ = command(
  ({ get, set }, token: number) => {
    if (get(internalLightboxDialogCloseToken$) !== token) {
      return;
    }
    set(internalLightboxDialogVisible$, false);
    set(internalLightboxDialogFullscreen$, false);
    set(internalLightboxState$, null);
  },
);

export const closeLightboxWithDialogExit$ = command(({ get, set }) => {
  const token = get(internalLightboxDialogCloseToken$) + 1;
  set(internalLightboxDialogCloseToken$, token);
  set(internalLightboxDialogVisible$, false);
  window.setTimeout(() => {
    set(closeLightboxForDialogExitToken$, token);
  }, LIGHTBOX_DIALOG_EXIT_DURATION_MS);
});

/**
 * An open artifact sidebar owns every artifact click that could live in it, so
 * the preview swaps the sidebar content instead of stacking a dialog over it.
 * Previews that cannot move into the sidebar keep the lightbox.
 *
 * This is opt-out: a new lightbox caller is routed unless it sets
 * `splitViewAvailable: false`. Set it whenever the preview is not a stored
 * thread artifact — a pending composer upload, or a synthetic `data:`/`blob:`
 * URL such as a rendered mermaid diagram — because the sidebar derives its
 * title and kind from the URL and offers artifact-only share, download, and
 * Drive-sync actions.
 */
const routeToOpenArtifactSidebar$ = command(
  ({ set }, value: { url: string; splitViewAvailable?: boolean }): boolean => {
    if (value.splitViewAvailable === false) {
      return false;
    }
    return set(openArtifactInOpenSidebar$, value.url);
  },
);

export const openImageLightbox$ = command(
  (
    { set },
    value:
      | string
      | {
          url: string;
          filename?: string;
          threadId?: string;
          artifact?: AttachmentArtifactMetadata;
          shareAvailable?: boolean;
          showSizeInSubtitle?: boolean;
          splitViewAvailable?: boolean;
        },
  ) => {
    const input = typeof value === "string" ? { url: value } : value;
    if (set(routeToOpenArtifactSidebar$, input)) {
      return;
    }
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    set(internalLightboxState$, { kind: "image", ...input });
  },
);

/**
 * Swap the previewed image without re-opening the dialog. Unlike
 * `openImageLightbox$`, this preserves the current fullscreen state and exit
 * animation token so keyboard/arrow navigation between images in the same
 * message does not collapse fullscreen.
 */
export const navigateImageLightbox$ = command(
  (
    { set },
    value: {
      url: string;
      filename?: string;
      threadId?: string;
      artifact?: AttachmentArtifactMetadata;
      shareAvailable?: boolean;
      showSizeInSubtitle?: boolean;
      splitViewAvailable?: boolean;
    },
  ) => {
    set(internalLightboxState$, { kind: "image", ...value });
  },
);

export const openDocumentLightbox$ = command(
  ({ set }, value: AttachmentDocumentLightboxInput) => {
    if (set(routeToOpenArtifactSidebar$, value)) {
      return;
    }
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    if (isAttachmentTextDocumentLightboxInput(value)) {
      set(internalLightboxState$, {
        ...value,
        text$: value.text$ ?? createTextPreviewComputed(value.url),
      });
      return;
    }
    set(internalLightboxState$, value);
  },
);

export const openVideoLightbox$ = command(
  (
    { set },
    value: {
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
      shareAvailable?: boolean;
      showSizeInSubtitle?: boolean;
      splitViewAvailable?: boolean;
    },
  ) => {
    if (set(routeToOpenArtifactSidebar$, value)) {
      return;
    }
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    set(internalLightboxState$, { kind: "video", ...value });
  },
);

export const openAudioLightbox$ = command(
  (
    { set },
    value: {
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
      shareAvailable?: boolean;
      showSizeInSubtitle?: boolean;
      splitViewAvailable?: boolean;
    },
  ) => {
    if (set(routeToOpenArtifactSidebar$, value)) {
      return;
    }
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    set(internalLightboxState$, { kind: "audio", ...value });
  },
);

// ---------------------------------------------------------------------------
// Escape-key handler for global attachment preview — closes on Escape
// ---------------------------------------------------------------------------

const closeLightboxOnEscape$ = command(
  ({ set }, el: HTMLDivElement, signal: AbortSignal) => {
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          set(closeLightboxWithDialogExit$);
        }
      },
      { capture: true, signal },
    );
    el.focus({ preventScroll: true });
  },
);

export const lightboxDialogRef$ = onRef(closeLightboxOnEscape$);
