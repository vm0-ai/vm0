import { command, computed } from "ccstate";

import { artifactSidebarInlineOpenEnabled$ } from "../external/feature-switch.ts";
import {
  classifyChatAttachment,
  previewAttachmentFromUrl,
} from "./parse-body-blocks.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import type { ArtifactRef, ThreadSidebarTarget } from "./thread-sidebar.ts";

// ---------------------------------------------------------------------------
// Page-level coordinator for the thread-owned utility sidebar. Sidebar state
// lives in the initiating thread's `ChatThreadSignals`; this module only
// enforces "at most one utility sidebar per page" across the two thread panes
// and routes every entry point into that thread-owned state.
// ---------------------------------------------------------------------------

/**
 * The single open utility sidebar on the page, with its owning thread. Null
 * while every pane's sidebar is closed.
 */
export const activeThreadSidebar$ = computed(
  (
    get,
  ): {
    readonly thread: ChatThreadSignals;
    readonly target: ThreadSidebarTarget;
    readonly animateEntry: boolean;
  } | null => {
    for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (!thread) {
        continue;
      }
      const target = get(thread.sidebar.target$);
      if (target) {
        return {
          thread,
          target,
          animateEntry: get(thread.sidebar.animateEntry$),
        };
      }
    }
    return null;
  },
);

const openOnThread$ = command(
  ({ get, set }, thread: ChatThreadSignals, target: ThreadSidebarTarget) => {
    for (const other of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (other && other.threadId !== thread.threadId) {
        set(other.sidebar.close$);
      }
    }
    set(thread.sidebar.open$, target);
  },
);

export const openThreadArtifacts$ = command(
  ({ set }, thread: ChatThreadSignals) => {
    set(openOnThread$, thread, { type: "artifacts" });
  },
);

export const openThreadAutomations$ = command(
  ({ set }, thread: ChatThreadSignals) => {
    set(openOnThread$, thread, { type: "automations" });
  },
);

/**
 * Resolve the pane that owns a per-message card id. Cards render inside their
 * thread, so exactly one pane's registry carries the id; the left (main) pane
 * wins in the impossible tie.
 */
function threadOwningCard(
  threads: readonly (ChatThreadSignals | null)[],
  owns: (thread: ChatThreadSignals) => boolean,
): ChatThreadSignals | null {
  for (const thread of threads) {
    if (thread && owns(thread)) {
      return thread;
    }
  }
  return threads.find(Boolean) ?? null;
}

export const openThreadMailDraft$ = command(
  ({ get, set }, mailDraftId: string) => {
    const thread = threadOwningCard(
      [get(currentLeftThread$), get(currentRightThread$)],
      (candidate) => {
        return get(candidate.mailDraftCardSignalsById$).has(mailDraftId);
      },
    );
    if (!thread) {
      return;
    }
    set(openOnThread$, thread, { type: "email-draft", mailDraftId });
  },
);

export const openThreadBrowserSession$ = command(
  ({ get, set }, threadId: string) => {
    const thread = [get(currentLeftThread$), get(currentRightThread$)].find(
      (candidate) => {
        return candidate?.threadId === threadId;
      },
    );
    if (!thread) {
      return;
    }
    set(openOnThread$, thread, { type: "browser" });
  },
);

export function artifactRefFromUrl(url: string): ArtifactRef {
  const attachment = previewAttachmentFromUrl(url);
  return {
    url,
    kind: classifyChatAttachment(attachment),
    filename: attachment.filename,
  };
}

/**
 * Promote a message attachment from the lightbox into split view. The lightbox
 * is page-global, so the main (left) thread hosts the sidebar.
 */
export const openThreadArtifactSplitView$ = command(
  ({ get, set }, url: string) => {
    const thread = get(currentLeftThread$) ?? get(currentRightThread$);
    if (!thread) {
      return;
    }
    set(openOnThread$, thread, {
      type: "artifact",
      source: { kind: "attachment", ref: artifactRefFromUrl(url) },
    });
  },
);

/**
 * Route an artifact click into an artifact sidebar the page already has open,
 * replacing its content in place. Returns false when the page has no artifact
 * sidebar, leaving the caller on its own preview surface.
 */
export const openArtifactInOpenSidebar$ = command(
  ({ get, set }, url: string): boolean => {
    if (!get(artifactSidebarInlineOpenEnabled$)) {
      return false;
    }
    const active = get(activeThreadSidebar$);
    if (
      active?.target.type !== "artifacts" &&
      active?.target.type !== "artifact"
    ) {
      return false;
    }
    // The owning thread already holds the page's only utility sidebar, so this
    // swaps its content without closing and reopening the pane.
    set(active.thread.sidebar.open$, {
      type: "artifact",
      source: { kind: "attachment", ref: artifactRefFromUrl(url) },
    });
    return true;
  },
);

/**
 * Card selection indicators for which mail draft / browser session the open
 * sidebar is showing, page-wide.
 */
export const activeSidebarMailDraftId$ = computed((get): string | null => {
  const active = get(activeThreadSidebar$);
  return active?.target.type === "email-draft"
    ? active.target.mailDraftId
    : null;
});

export const activeSidebarBrowserThreadId$ = computed((get): string | null => {
  const active = get(activeThreadSidebar$);
  return active?.target.type === "browser" ? active.thread.threadId : null;
});
