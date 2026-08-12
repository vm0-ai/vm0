import { command, computed, state, type Command, type Computed } from "ccstate";

import {
  createArtifactCatalogSignals,
  type ArtifactCatalogSignals,
} from "../artifacts-page/create-artifact-catalog-signals.ts";
import { artifactDetailPreview } from "../artifacts-page/artifact-catalog-signals.ts";
import {
  fetchPreviewText,
  isTextPreviewKind,
  type TextPreviewComputed,
} from "../text-preview.ts";
import {
  createMarkdownPreviewTree,
  type MarkdownPreviewTreeComputed,
} from "../markdown-preview-tree.ts";
import type { MailDraftSignals } from "./mail-draft.ts";

// ---------------------------------------------------------------------------
// Thread-owned utility sidebar.
//
// One thread holds at most one open sidebar target; the five target types are
// mutually exclusive by construction because they share a single state. The
// page-level coordinator (`thread-sidebar-coordinator.ts`) additionally keeps
// at most one utility sidebar open across the left and right thread panes.
// ---------------------------------------------------------------------------

/**
 * The artifact detail target serves two entry paths: a card opened from the
 * thread's catalog list, and a message attachment promoted from the lightbox
 * into split view.
 */
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

export type ArtifactRef = {
  readonly url: string;
  readonly kind: ArtifactPreviewKind;
  readonly filename: string;
  readonly shareAvailable?: boolean;
  readonly releaseObjectUrl?: () => void;
  /**
   * Text preview content for text-kind refs, resolved by the opening command
   * from the owning thread's artifact signals. The sidebar renders from the
   * ref alone.
   */
  readonly text$?: TextPreviewComputed;
  /** The prepared tree for markdown-kind refs, diagram signals embedded. */
  readonly markdownTree$?: MarkdownPreviewTreeComputed;
};

export type ArtifactFileRef = {
  readonly file: File;
  readonly url: string;
  readonly shareAvailable?: boolean;
};

export type ArtifactMetadataRef = {
  readonly url: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly shareAvailable?: boolean;
  readonly text$?: TextPreviewComputed;
};

export type ArtifactRefInput = string | ArtifactFileRef | ArtifactMetadataRef;

export type ThreadSidebarArtifactSource =
  | { readonly kind: "catalog"; readonly artifactId: string }
  | { readonly kind: "attachment"; readonly ref: ArtifactRef };

export type ThreadSidebarTarget =
  | { readonly type: "artifacts" }
  | { readonly type: "artifact"; readonly source: ThreadSidebarArtifactSource }
  | { readonly type: "email-draft"; readonly signals: MailDraftSignals }
  | { readonly type: "browser" }
  | { readonly type: "automations" };

export interface ThreadSidebarSignals {
  readonly target$: Computed<ThreadSidebarTarget | null>;
  readonly open$: Command<void, [ThreadSidebarTarget]>;
  readonly close$: Command<void, []>;
  /**
   * Whether the current sidebar session should animate into the split layout.
   * The first IndexedDB-driven auto-open captures `false`; later opens capture
   * `true` after the initial cache read completes.
   */
  readonly animateEntry$: Computed<boolean>;
  readonly enableEntryAnimations$: Command<void, []>;
  readonly editingAutomationId$: Computed<string | null>;
  readonly setEditingAutomationId$: Command<void, [string | null]>;
  /**
   * Claim a derived auto-open candidate once for this thread. This prevents
   * later sync events from reopening a card the user already closed.
   */
  readonly claimAutoOpenCandidate$: Command<boolean, [string]>;
  /**
   * Sidebar fullscreen. Only the `artifacts` list and `artifact` detail render
   * a fullscreen toggle; the state belongs to the current sidebar session and
   * clears whenever the target type changes or the sidebar closes.
   */
  readonly fullscreen$: Computed<boolean>;
  readonly toggleFullscreen$: Command<void, []>;
  /**
   * Thread-scoped artifact catalog. Loaded pages persist across sidebar
   * close/reopen — ccstate computeds keep the cache — and are only dropped
   * with the thread signals themselves on a thread switch.
   */
  readonly artifactCatalog: ArtifactCatalogSignals;
  readonly selectedArtifactText$: Computed<Promise<string>>;
  readonly selectedArtifactMarkdownTree$: MarkdownPreviewTreeComputed;
}

function attachmentObjectUrlRelease(
  target: ThreadSidebarTarget | null,
): (() => void) | undefined {
  return target?.type === "artifact" && target.source.kind === "attachment"
    ? target.source.ref.releaseObjectUrl
    : undefined;
}

export function createThreadSidebarSignals(
  threadId: string,
): ThreadSidebarSignals {
  const internalTarget$ = state<ThreadSidebarTarget | null>(null);
  const internalEntryAnimationsEnabled$ = state(false);
  const internalAnimateEntry$ = state(false);
  const internalFullscreen$ = state(false);
  const internalEditingAutomationId$ = state<string | null>(null);
  const internalClaimedAutoOpenCandidateKey$ = state<string | null>(null);

  const artifactCatalog = createArtifactCatalogSignals({
    chatThreadId: threadId,
  });
  const selectedArtifactText$ = computed(async (get): Promise<string> => {
    const detail = await get(artifactCatalog.selectedArtifactDetail$);
    if (!detail) {
      throw new Error("Selected artifact is unavailable");
    }
    const preview = artifactDetailPreview(detail);
    if (!isTextPreviewKind(preview.kind)) {
      throw new Error("Selected artifact is not a text preview");
    }
    return fetchPreviewText(preview.url);
  });
  const selectedArtifactMarkdownTree$ = createMarkdownPreviewTree(
    selectedArtifactText$,
  );

  const open$ = command(({ get, set }, target: ThreadSidebarTarget) => {
    const current = get(internalTarget$);
    const currentObjectUrlRelease = attachmentObjectUrlRelease(current);
    const nextObjectUrlRelease = attachmentObjectUrlRelease(target);
    if (current === null) {
      set(internalAnimateEntry$, get(internalEntryAnimationsEnabled$));
    }
    if (current?.type !== target.type) {
      set(internalFullscreen$, false);
    }
    if (target.type === "artifact" && target.source.kind === "catalog") {
      set(artifactCatalog.selectArtifact$, target.source.artifactId);
    }
    set(internalTarget$, target);
    if (
      currentObjectUrlRelease &&
      currentObjectUrlRelease !== nextObjectUrlRelease
    ) {
      currentObjectUrlRelease();
    }
  });

  const close$ = command(({ get, set }) => {
    const objectUrlRelease = attachmentObjectUrlRelease(get(internalTarget$));
    set(internalTarget$, null);
    set(internalAnimateEntry$, false);
    set(internalFullscreen$, false);
    set(internalEditingAutomationId$, null);
    objectUrlRelease?.();
  });

  const claimAutoOpenCandidate$ = command(
    ({ get, set }, candidateKey: string): boolean => {
      if (get(internalClaimedAutoOpenCandidateKey$) === candidateKey) {
        return false;
      }
      set(internalClaimedAutoOpenCandidateKey$, candidateKey);
      return true;
    },
  );

  return {
    target$: computed((get) => {
      return get(internalTarget$);
    }),
    open$,
    close$,
    animateEntry$: computed((get) => {
      return get(internalAnimateEntry$);
    }),
    enableEntryAnimations$: command(({ set }) => {
      set(internalEntryAnimationsEnabled$, true);
    }),
    editingAutomationId$: computed((get) => {
      return get(internalEditingAutomationId$);
    }),
    setEditingAutomationId$: command(({ set }, automationId: string | null) => {
      set(internalEditingAutomationId$, automationId);
    }),
    claimAutoOpenCandidate$,
    fullscreen$: computed((get) => {
      return get(internalFullscreen$);
    }),
    toggleFullscreen$: command(({ set }) => {
      set(internalFullscreen$, (fullscreen) => {
        return !fullscreen;
      });
    }),
    artifactCatalog,
    selectedArtifactText$,
    selectedArtifactMarkdownTree$,
  };
}
