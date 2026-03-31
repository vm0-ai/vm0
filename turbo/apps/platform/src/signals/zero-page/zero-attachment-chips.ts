import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

// ---------------------------------------------------------------------------
// Lightbox state — tracks which image URL is open in the lightbox
// ---------------------------------------------------------------------------

const internalLightboxUrl$ = state<string | null>(null);

export const lightboxUrl$ = computed((get) => {
  return get(internalLightboxUrl$);
});

export const setLightboxUrl$ = command(({ set }, value: string | null) => {
  set(internalLightboxUrl$, value);
});

// ---------------------------------------------------------------------------
// Escape-key handler for ImageLightbox — closes lightbox on Escape
// ---------------------------------------------------------------------------

const closeLightboxOnEscape$ = command(
  ({ set }, el: HTMLDivElement, signal: AbortSignal) => {
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          set(internalLightboxUrl$, null);
        }
      },
      { signal },
    );
    el.focus();
  },
);

export const lightboxDialogRef$ = onRef(closeLightboxOnEscape$);
