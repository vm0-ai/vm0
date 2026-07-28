import { command, computed, state, type Command, type Computed } from "ccstate";

import {
  createArtifactCatalogSignals,
  type ArtifactCatalogSignals,
} from "../artifacts-page/create-artifact-catalog-signals.ts";
import { resetSignal } from "../utils.ts";
import type { ArtifactRef } from "../zero-page/zero-artifact-sidebar.ts";

// ---------------------------------------------------------------------------
// Thread-owned utility sidebar (NewChatThreadSidebar feature switch).
//
// One thread holds at most one open sidebar target; the five target types are
// mutually exclusive by construction because they share a single state. The
// page-level coordinator (`thread-sidebar-coordinator.ts`) additionally keeps
// at most one utility sidebar open across the left and right thread panes.
// Legacy search-param sidebars stay untouched while the switch is off.
// ---------------------------------------------------------------------------

/**
 * The artifact detail target serves two entry paths: a card opened from the
 * thread's catalog list, and a message attachment promoted from the lightbox
 * into split view.
 */
export type ThreadSidebarArtifactSource =
  | { readonly kind: "catalog"; readonly artifactId: string }
  | { readonly kind: "attachment"; readonly ref: ArtifactRef };

export type ThreadSidebarTarget =
  | { readonly type: "artifacts" }
  | { readonly type: "artifact"; readonly source: ThreadSidebarArtifactSource }
  | { readonly type: "email-draft"; readonly mailDraftId: string }
  | { readonly type: "browser"; readonly browserSessionId: string }
  | { readonly type: "automations" };

export interface ThreadSidebarSignals {
  readonly target$: Computed<ThreadSidebarTarget | null>;
  readonly open$: Command<void, [ThreadSidebarTarget]>;
  readonly close$: Command<void, []>;
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
  /**
   * Session resources for an open artifacts list: refresh the first page in
   * the background and follow realtime catalog changes. `close$` aborts the
   * session without touching the cached list.
   */
  readonly setupArtifactsSession$: Command<Promise<void>, [AbortSignal]>;
}

export function createThreadSidebarSignals(
  threadId: string,
): ThreadSidebarSignals {
  const internalTarget$ = state<ThreadSidebarTarget | null>(null);
  const internalFullscreen$ = state(false);
  const internalClaimedAutoOpenCandidateKey$ = state<string | null>(null);
  const resetSession$ = resetSignal();

  const artifactCatalog = createArtifactCatalogSignals({
    chatThreadId: threadId,
  });

  const open$ = command(({ get, set }, target: ThreadSidebarTarget) => {
    const current = get(internalTarget$);
    if (current?.type !== target.type) {
      set(internalFullscreen$, false);
    }
    if (target.type === "artifact" && target.source.kind === "catalog") {
      set(artifactCatalog.selectArtifact$, target.source.artifactId);
    }
    set(internalTarget$, target);
  });

  const close$ = command(({ set }) => {
    // Abort session resources (realtime subscription, background refresh)
    // while keeping the cached catalog pages for the next open.
    set(resetSession$);
    set(internalTarget$, null);
    set(internalFullscreen$, false);
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

  const setupArtifactsSession$ = command(
    async ({ set }, parentSignal: AbortSignal): Promise<void> => {
      const signal = set(resetSession$, parentSignal);
      set(artifactCatalog.reload$);
      await set(artifactCatalog.subscribeCatalogChanged$, signal);
    },
  );

  return {
    target$: computed((get) => {
      return get(internalTarget$);
    }),
    open$,
    close$,
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
    setupArtifactsSession$,
  };
}
