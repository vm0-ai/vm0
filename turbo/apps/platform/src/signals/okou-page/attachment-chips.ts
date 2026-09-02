import { command, computed, state } from "ccstate";
import { timeout } from "signal-timers";
import { openArtifactInOpenSidebar$ } from "../chat-page/thread-sidebar-coordinator.ts";
import {
  createMarkdownPreviewTree,
  type MarkdownPreviewTreeComputed,
} from "../markdown-preview-tree.ts";
import type { ArtifactRefInput } from "../chat-page/thread-sidebar.ts";
import { previewAttachmentFromUrl } from "../chat-page/parse-body-blocks.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
  type TextPreviewComputed,
  type TextPreviewKind,
} from "../text-preview.ts";
import { onRef, resetSignal } from "../utils.ts";
import {
  createObjectUrlResource,
  type ObjectUrlResource,
} from "../object-url-resource.ts";
import { rootSignal$ } from "../root-signal.ts";
import type { AnnotationTarget } from "./image-annotation.ts";

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

interface AttachmentNamedLightboxBase {
  readonly url: string;
  readonly filename: string;
  readonly artifact?: AttachmentArtifactMetadata;
  readonly shareAvailable?: boolean;
  readonly showSizeInSubtitle?: boolean;
  readonly splitViewAvailable?: boolean;
}

type AttachmentTextDocumentLightboxInput = AttachmentNamedLightboxBase & {
  readonly kind: TextPreviewKind;
  readonly text$?: TextPreviewComputed;
};

type AttachmentFramedDocumentLightboxInput = AttachmentNamedLightboxBase & {
  readonly kind: "html" | "pdf";
};

type AttachmentFileLightboxInput = AttachmentNamedLightboxBase & {
  readonly kind: "file";
};

type AttachmentDocumentLightboxInput =
  | AttachmentTextDocumentLightboxInput
  | AttachmentFramedDocumentLightboxInput;

type AttachmentImageLightboxInput = {
  readonly url: string;
  readonly file?: File;
  /**
   * Present only for an image the viewer is allowed to mark up — a composer
   * draft. Artifacts and sent messages open the same lightbox without it, so
   * the annotate affordance simply is not there for something immutable.
   */
  readonly annotationTarget?: AnnotationTarget;
  readonly filename?: string;
  readonly threadId?: string;
  readonly artifact?: AttachmentArtifactMetadata;
  readonly shareAvailable?: boolean;
  readonly showSizeInSubtitle?: boolean;
  readonly splitViewAvailable?: boolean;
};

export type AttachmentDocumentLightboxState =
  | (AttachmentNamedLightboxBase & {
      readonly kind: Exclude<TextPreviewKind, "markdown">;
      readonly text$: TextPreviewComputed;
    })
  | (AttachmentNamedLightboxBase & {
      readonly kind: "markdown";
      readonly text$: TextPreviewComputed;
      /** Prepared render tree, diagram signals embedded. */
      readonly markdownTree$: MarkdownPreviewTreeComputed;
    })
  | AttachmentFramedDocumentLightboxInput;

function isAttachmentTextDocumentLightboxInput(
  value: AttachmentDocumentLightboxInput,
): value is AttachmentTextDocumentLightboxInput {
  return isTextPreviewKind(value.kind);
}

type AttachmentImageLightboxState = AttachmentImageLightboxInput & {
  readonly kind: "image";
};

export type AttachmentLightboxState =
  | AttachmentImageLightboxState
  | AttachmentDocumentLightboxState
  | AttachmentFileLightboxInput
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
const internalLightboxDialogMountToken$ = state(0);
const resetLightboxDialogCloseSignal$ = resetSignal();
const resetLightboxPreviewSignal$ = resetSignal();
const internalLightboxObjectUrlResources$ = state<readonly ObjectUrlResource[]>(
  [],
);

const releaseLightboxObjectUrlResources$ = command(({ get, set }) => {
  for (const resource of get(internalLightboxObjectUrlResources$)) {
    resource.release();
  }
  set(internalLightboxObjectUrlResources$, []);
});

const disposeLightboxSession$ = command(({ set }) => {
  set(internalLightboxDialogCloseToken$, (value) => {
    return value + 1;
  });
  set(internalLightboxDialogVisible$, false);
  set(internalLightboxDialogFullscreen$, false);
  set(internalLightboxState$, null);
  set(resetLightboxPreviewSignal$);
  set(releaseLightboxObjectUrlResources$);
});

/**
 * Closes without the exit animation. Handing the screen to the annotation
 * editor used to animate the viewer out while the editor animated in, and the
 * two transitions read as the modal jumping.
 */
export const closeLightboxImmediately$ = command(({ set }) => {
  set(disposeLightboxSession$);
});

const disposeLightboxForDialogUnmountToken$ = command(
  ({ get, set }, token: number) => {
    if (get(internalLightboxDialogMountToken$) !== token) {
      return;
    }
    set(disposeLightboxSession$);
  },
);

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
    set(resetLightboxPreviewSignal$);
    set(releaseLightboxObjectUrlResources$);
  },
);

export const closeLightboxWithDialogExit$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const closeSignal = set(resetLightboxDialogCloseSignal$, signal);
    const token = get(internalLightboxDialogCloseToken$) + 1;
    set(internalLightboxDialogCloseToken$, token);
    set(internalLightboxDialogVisible$, false);
    timeout(
      () => {
        set(closeLightboxForDialogExitToken$, token);
      },
      LIGHTBOX_DIALOG_EXIT_DURATION_MS,
      { signal: closeSignal },
    );
  },
);

/**
 * An open artifact sidebar owns every artifact click that could live in it, so
 * the preview swaps the sidebar content instead of stacking a dialog over it.
 * Previews that cannot move into the sidebar keep the lightbox.
 *
 * This is opt-out: a new lightbox caller is routed unless it sets
 * `splitViewAvailable: false`. Set it for previews that do not belong in the
 * thread sidebar, such as a pending composer upload. File-backed previews pass
 * the File metadata so each destination can create an object URL for its own
 * consumer lifetime while preserving the name and content type.
 */
type AttachmentSidebarPreviewInput = {
  readonly url: string;
  readonly file?: File;
  readonly filename?: string;
  readonly contentType?: string;
  readonly shareAvailable?: boolean;
  readonly splitViewAvailable?: boolean;
  readonly text$?: TextPreviewComputed;
};

export function attachmentSidebarRef(
  value: AttachmentSidebarPreviewInput,
): ArtifactRefInput {
  const share =
    value.shareAvailable === undefined
      ? {}
      : { shareAvailable: value.shareAvailable };
  if (value.file) {
    return { file: value.file, url: value.url, ...share };
  }
  if (value.filename) {
    const contentType =
      value.contentType ??
      previewAttachmentFromUrl(value.url, value.filename).contentType;
    return {
      url: value.url,
      filename: value.filename,
      ...(contentType ? { contentType } : {}),
      // The caller's preview content rides along, so the sidebar reuses the
      // already-fetched text instead of fetching its own copy.
      ...(value.text$ ? { text$: value.text$ } : {}),
      ...share,
    };
  }
  return value.url;
}

const routeToOpenArtifactSidebar$ = command(
  ({ set }, value: AttachmentSidebarPreviewInput): boolean => {
    if (value.splitViewAvailable === false) {
      return false;
    }
    return set(openArtifactInOpenSidebar$, attachmentSidebarRef(value));
  },
);

function imageLightboxState(
  input: AttachmentImageLightboxInput,
): AttachmentImageLightboxState {
  if (!input.file) {
    return { kind: "image", ...input };
  }
  return {
    kind: "image",
    ...input,
    filename: input.filename ?? input.file.name,
  };
}

export const openImageLightbox$ = command(
  ({ get, set }, value: string | AttachmentImageLightboxInput) => {
    const input = typeof value === "string" ? { url: value } : value;
    if (set(routeToOpenArtifactSidebar$, input)) {
      return;
    }
    const previewSignal = set(resetLightboxPreviewSignal$, get(rootSignal$));
    const resource = input.file
      ? createObjectUrlResource(input.file, previewSignal)
      : undefined;
    if (resource) {
      set(internalLightboxObjectUrlResources$, (current) => {
        return [...current, resource];
      });
    }
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    set(
      internalLightboxState$,
      imageLightboxState(resource ? { ...input, url: resource.url } : input),
    );
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
    { get, set },
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
    set(resetLightboxPreviewSignal$, get(rootSignal$));
    set(internalLightboxState$, { kind: "image", ...value });
  },
);

export const openDocumentLightbox$ = command(
  ({ get, set }, value: AttachmentDocumentLightboxInput) => {
    if (set(routeToOpenArtifactSidebar$, value)) {
      return;
    }
    const previewSignal = set(resetLightboxPreviewSignal$, get(rootSignal$));
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    if (isAttachmentTextDocumentLightboxInput(value)) {
      const text$ = value.text$ ?? createTextPreviewComputed(value.url);
      if (value.kind === "markdown") {
        set(internalLightboxState$, {
          ...value,
          kind: "markdown",
          text$,
          markdownTree$: createMarkdownPreviewTree(text$, previewSignal),
        });
        return;
      }
      set(internalLightboxState$, { ...value, kind: value.kind, text$ });
      return;
    }
    set(internalLightboxState$, value);
  },
);

export const openFileLightbox$ = command(
  ({ get, set }, value: Omit<AttachmentFileLightboxInput, "kind">) => {
    if (set(routeToOpenArtifactSidebar$, value)) {
      return;
    }
    set(resetLightboxPreviewSignal$, get(rootSignal$));
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    set(internalLightboxState$, { kind: "file", ...value });
  },
);

export const openVideoLightbox$ = command(
  (
    { get, set },
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
    set(resetLightboxPreviewSignal$, get(rootSignal$));
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
    { get, set },
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
    set(resetLightboxPreviewSignal$, get(rootSignal$));
    set(internalLightboxDialogCloseToken$, (value) => {
      return value + 1;
    });
    set(internalLightboxDialogVisible$, true);
    set(internalLightboxDialogFullscreen$, false);
    set(internalLightboxState$, { kind: "audio", ...value });
  },
);

// ---------------------------------------------------------------------------
// Global attachment preview mount owner — releases resources on route unmount
// ---------------------------------------------------------------------------

const ownLightboxDialogMount$ = command(
  ({ get, set }, _element: HTMLDivElement, signal: AbortSignal) => {
    const mountToken = get(internalLightboxDialogMountToken$) + 1;
    set(internalLightboxDialogMountToken$, mountToken);
    signal.addEventListener(
      "abort",
      () => {
        // React can detach and immediately reattach a callback ref during a
        // render or StrictMode check. Defer disposal so that replacement mount
        // can supersede this token; a real route unmount has no replacement.
        queueMicrotask(() => {
          set(disposeLightboxForDialogUnmountToken$, mountToken);
        });
      },
      { once: true },
    );
  },
);

export const lightboxDialogMountRef$ = onRef(ownLightboxDialogMount$);
