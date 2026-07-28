import { command, computed } from "ccstate";

import {
  chatThreadSidebarAutoOpenEnabled$,
  newChatThreadSidebarEnabled$,
} from "../external/feature-switch.ts";
import { openMailDraftSidebar$ } from "../zero-page/mail-draft-sidebar.ts";
import { openBrowserSessionSidebar$ } from "../zero-page/browser-session-sidebar.ts";
import {
  openArtifactInbox$,
  openArtifactSidebarPreview$,
  type ArtifactRef,
} from "../zero-page/zero-artifact-sidebar.ts";
import {
  classifyChatAttachment,
  previewAttachmentFromUrl,
} from "./parse-body-blocks.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-pane-state.ts";
import { openHeaderAutomationSidebar$ } from "./header-automation-sidebar.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import { CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY } from "./chat-thread-sidebar-layout.ts";
import type { ThreadSidebarTarget } from "./thread-sidebar.ts";
import {
  threadSidebarAutoOpenCandidateKey,
  type ThreadSidebarAutoOpenCandidate,
} from "./thread-sidebar-auto-open.ts";

// ---------------------------------------------------------------------------
// Page-level coordinator for the thread-owned utility sidebar. Sidebar state
// lives in the initiating thread's `ChatThreadSignals`; this module only
// enforces "at most one utility sidebar per page" across the two thread panes
// and routes each entry point to the legacy search-param sidebars while the
// `NewChatThreadSidebar` switch is off.
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
  } | null => {
    for (const thread of [get(currentLeftThread$), get(currentRightThread$)]) {
      if (!thread) {
        continue;
      }
      const target = get(thread.sidebar.target$);
      if (target) {
        return { thread, target };
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

function targetFromAutoOpenCandidate(
  candidate: ThreadSidebarAutoOpenCandidate,
): ThreadSidebarTarget {
  if (candidate.type === "email-draft") {
    return { type: "email-draft", mailDraftId: candidate.resourceKey };
  }
  if (candidate.type === "browser") {
    return { type: "browser", browserSessionId: candidate.resourceKey };
  }
  const attachment = previewAttachmentFromUrl(candidate.resourceKey);
  const ref: ArtifactRef = {
    source: "url",
    url: candidate.resourceKey,
    kind: classifyChatAttachment(attachment),
    filename: attachment.filename,
  };
  return {
    type: "artifact",
    source: { kind: "attachment", ref },
  };
}

export const autoOpenThreadSidebar$ = command(
  async (
    { get, set },
    thread: ChatThreadSignals,
    signal: AbortSignal,
  ): Promise<void> => {
    await get(thread.hasNewMessages$);
    signal.throwIfAborted();
    if (
      !get(newChatThreadSidebarEnabled$) ||
      !get(chatThreadSidebarAutoOpenEnabled$) ||
      typeof window === "undefined" ||
      !window.matchMedia(CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY).matches
    ) {
      return;
    }

    const candidate = await get(thread.sidebarAutoOpenCandidate$);
    signal.throwIfAborted();
    if (!candidate) {
      return;
    }

    const visible = [get(currentLeftThread$), get(currentRightThread$)].some(
      (current) => {
        return current === thread;
      },
    );
    if (!visible) {
      return;
    }

    const candidateKey = threadSidebarAutoOpenCandidateKey(candidate);
    if (!set(thread.sidebar.claimAutoOpenCandidate$, candidateKey)) {
      return;
    }
    if (
      !get(newChatThreadSidebarEnabled$) ||
      !get(chatThreadSidebarAutoOpenEnabled$) ||
      typeof window === "undefined" ||
      !window.matchMedia(CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY).matches ||
      get(activeThreadSidebar$) !== null
    ) {
      return;
    }
    set(openOnThread$, thread, targetFromAutoOpenCandidate(candidate));
  },
);

export const openThreadArtifacts$ = command(
  ({ get, set }, thread: ChatThreadSignals) => {
    if (!get(newChatThreadSidebarEnabled$)) {
      set(openArtifactInbox$, thread.threadId);
      return;
    }
    set(openOnThread$, thread, { type: "artifacts" });
  },
);

export const openThreadAutomations$ = command(
  ({ get, set }, thread: ChatThreadSignals) => {
    if (!get(newChatThreadSidebarEnabled$)) {
      set(openHeaderAutomationSidebar$, thread.threadId);
      return;
    }
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
    if (!get(newChatThreadSidebarEnabled$)) {
      set(openMailDraftSidebar$, mailDraftId);
      return;
    }
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
  ({ get, set }, browserSessionId: string) => {
    if (!get(newChatThreadSidebarEnabled$)) {
      set(openBrowserSessionSidebar$, browserSessionId);
      return;
    }
    const thread = threadOwningCard(
      [get(currentLeftThread$), get(currentRightThread$)],
      (candidate) => {
        return get(candidate.browserSessionCardSignalsById$).has(
          browserSessionId,
        );
      },
    );
    if (!thread) {
      return;
    }
    set(openOnThread$, thread, { type: "browser", browserSessionId });
  },
);

/**
 * Promote a message attachment from the lightbox into split view. The lightbox
 * is page-global, so the main (left) thread hosts the sidebar.
 */
export const openThreadArtifactSplitView$ = command(
  ({ get, set }, url: string) => {
    if (!get(newChatThreadSidebarEnabled$)) {
      set(openArtifactSidebarPreview$, url);
      return;
    }
    const thread = get(currentLeftThread$) ?? get(currentRightThread$);
    if (!thread) {
      return;
    }
    const attachment = previewAttachmentFromUrl(url);
    const ref: ArtifactRef = {
      source: "url",
      url,
      kind: classifyChatAttachment(attachment),
      filename: attachment.filename,
    };
    set(openOnThread$, thread, {
      type: "artifact",
      source: { kind: "attachment", ref },
    });
  },
);

/**
 * Card selection indicators for the new track: which mail draft / browser
 * session the open sidebar is showing, page-wide.
 */
export const activeSidebarMailDraftId$ = computed((get): string | null => {
  const active = get(activeThreadSidebar$);
  return active?.target.type === "email-draft"
    ? active.target.mailDraftId
    : null;
});

export const activeSidebarBrowserSessionId$ = computed((get): string | null => {
  const active = get(activeThreadSidebar$);
  return active?.target.type === "browser"
    ? active.target.browserSessionId
    : null;
});
