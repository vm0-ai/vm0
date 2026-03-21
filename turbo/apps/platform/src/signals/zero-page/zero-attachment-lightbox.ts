import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

// ---------------------------------------------------------------------------
// Attachment lightbox state (shared across AttachmentChips)
// ---------------------------------------------------------------------------

const internalLightboxUrl$ = state<string | null>(null);

export const attachmentLightboxUrl$ = computed((get) =>
  get(internalLightboxUrl$),
);

export const openAttachmentLightbox$ = command(({ set }, url: string) => {
  set(internalLightboxUrl$, url);
});

export const closeAttachmentLightbox$ = command(({ set }) => {
  set(internalLightboxUrl$, null);
});

// ---------------------------------------------------------------------------
// Escape key dismiss ref — closes the attachment lightbox on Escape
// ---------------------------------------------------------------------------

const escapeKeydown$ = command(
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

export const attachmentLightboxRef$ = onRef(escapeKeydown$);
