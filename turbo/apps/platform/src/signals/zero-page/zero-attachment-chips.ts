import { command, computed, state } from "ccstate";
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
  readonly googleDriveSynced: boolean;
  readonly onSyncSuccess?: () => void;
  readonly runId: string;
  readonly size: number;
  readonly threadId: string;
};

export type AttachmentLightboxState =
  | {
      kind: "image";
      url: string;
      filename?: string;
      artifact?: AttachmentArtifactMetadata;
    }
  | {
      kind: "markdown" | "text" | "json" | "csv" | "html" | "pdf";
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
    }
  | {
      kind: "audio" | "video";
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
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

export const openImageLightbox$ = command(
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
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    if (typeof value === "string") {
      set(internalLightboxState$, { kind: "image", url: value });
      return;
    }
    set(internalLightboxState$, { kind: "image", ...value });
  },
);

export const openDocumentLightbox$ = command(
  (
    { set },
    value: {
      kind: "markdown" | "text" | "json" | "csv" | "html" | "pdf";
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
    },
  ) => {
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
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
    },
  ) => {
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
    },
  ) => {
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    set(internalLightboxState$, { kind: "audio", ...value });
  },
);

export const closeLightbox$ = command(({ set }) => {
  set(internalLightboxDialogCloseToken$, (value) => {
    return value + 1;
  });
  set(internalLightboxDialogVisible$, false);
  set(internalLightboxDialogFullscreen$, false);
  set(internalLightboxState$, null);
});

// ---------------------------------------------------------------------------
// Escape-key handler for global attachment preview — closes on Escape
// ---------------------------------------------------------------------------

const closeLightboxOnEscape$ = command(
  ({ set }, el: HTMLDivElement, signal: AbortSignal) => {
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          set(internalLightboxDialogCloseToken$, (value) => {
            return value + 1;
          });
          set(internalLightboxDialogVisible$, false);
          set(internalLightboxDialogFullscreen$, false);
          set(internalLightboxState$, null);
        }
      },
      { signal },
    );
    el.focus();
  },
);

export const lightboxDialogRef$ = onRef(closeLightboxOnEscape$);
