import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

// ---------------------------------------------------------------------------
// Lightbox state — tracks which attachment is open in the global preview UI
// ---------------------------------------------------------------------------

type AttachmentLightboxState =
  | {
      kind: "image";
      url: string;
      filename?: string;
    }
  | {
      kind: "markdown" | "text" | "json" | "csv" | "html" | "pdf";
      url: string;
      filename: string;
    }
  | {
      kind: "video";
      url: string;
      filename: string;
    };

const internalLightboxState$ = state<AttachmentLightboxState | null>(null);

export const lightboxUrl$ = computed((get) => {
  return get(internalLightboxState$);
});

export const openImageLightbox$ = command(({ set }, url: string) => {
  set(internalLightboxState$, { kind: "image", url });
});

export const openDocumentLightbox$ = command(
  (
    { set },
    value: {
      kind: "markdown" | "text" | "json" | "csv" | "html" | "pdf";
      url: string;
      filename: string;
    },
  ) => {
    set(internalLightboxState$, value);
  },
);

export const openVideoLightbox$ = command(
  (
    { set },
    value: {
      url: string;
      filename: string;
    },
  ) => {
    set(internalLightboxState$, { kind: "video", ...value });
  },
);

export const closeLightbox$ = command(({ set }) => {
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
          set(internalLightboxState$, null);
        }
      },
      { signal },
    );
    el.focus();
  },
);

export const lightboxDialogRef$ = onRef(closeLightboxOnEscape$);
