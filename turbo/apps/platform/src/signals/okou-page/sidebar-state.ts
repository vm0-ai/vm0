import { command, computed, state } from "ccstate";
import { localStorageSignals } from "../external/local-storage.ts";

// ---------------------------------------------------------------------------
// Chat list dialog search query
// ---------------------------------------------------------------------------
const internalChatListQuery$ = state("");
export const chatListQuery$ = computed((get) => {
  return get(internalChatListQuery$);
});
export const setChatListQuery$ = command(({ set }, query: string) => {
  set(internalChatListQuery$, query);
});

// ---------------------------------------------------------------------------
// Delete confirmation dialog state (RecentChatList)
// ---------------------------------------------------------------------------
const internalPendingDeleteThreadId$ = state<string | null>(null);
export const pendingDeleteThreadId$ = computed((get) => {
  return get(internalPendingDeleteThreadId$);
});
export const setPendingDeleteThreadId$ = command(
  ({ set }, id: string | null) => {
    set(internalPendingDeleteThreadId$, id);
  },
);

// ---------------------------------------------------------------------------
// Rename dialog state (RecentChatList)
// ---------------------------------------------------------------------------
const internalRenameDialogOpen$ = state(false);
export const renameDialogOpen$ = computed((get) => {
  return get(internalRenameDialogOpen$);
});

const internalRenameDialogThreadId$ = state<string | null>(null);
export const renameDialogThreadId$ = computed((get) => {
  return get(internalRenameDialogThreadId$);
});

const internalRenameDialogAgentId$ = state<string | null>(null);
export const renameDialogAgentId$ = computed((get) => {
  return get(internalRenameDialogAgentId$);
});

const internalRenameDialogInput$ = state("");
export const renameDialogInput$ = computed((get) => {
  return get(internalRenameDialogInput$);
});
export const setRenameDialogInput$ = command(({ set }, input: string) => {
  set(internalRenameDialogInput$, input);
});

export const openRenameChatThreadDialog$ = command(
  (
    { set },
    {
      threadId,
      title,
      agentId,
    }: {
      threadId: string;
      title: string | null | undefined;
      agentId?: string | null | undefined;
    },
  ) => {
    set(internalRenameDialogInput$, title?.trim() ?? "");
    set(internalRenameDialogAgentId$, agentId?.trim() || null);
    set(internalRenameDialogThreadId$, threadId);
    set(internalRenameDialogOpen$, true);
  },
);

export const closeRenameChatThreadDialog$ = command(({ set }) => {
  set(internalRenameDialogOpen$, false);
});

// ---------------------------------------------------------------------------
// Emoji picker menu state (chat header)
// ---------------------------------------------------------------------------
const internalEmojiMenuThreadId$ = state<string | null>(null);
export const emojiMenuThreadId$ = computed((get) => {
  return get(internalEmojiMenuThreadId$);
});

const internalEmojiMenuTitle$ = state<string | null>(null);
export const emojiMenuTitle$ = computed((get) => {
  return get(internalEmojiMenuTitle$);
});

export const openChatThreadEmojiMenu$ = command(
  (
    { set },
    { threadId, title }: { threadId: string; title: string | null | undefined },
  ) => {
    set(internalEmojiMenuTitle$, title?.trim() || null);
    set(internalEmojiMenuThreadId$, threadId);
  },
);

export const closeChatThreadEmojiMenu$ = command(({ set }) => {
  set(internalEmojiMenuThreadId$, null);
  set(internalEmojiMenuTitle$, null);
});

// ---------------------------------------------------------------------------
// Session list collapse state (RecentChatSection) — persisted in localStorage
// ---------------------------------------------------------------------------
const {
  get$: sessionListCollapsedRaw$,
  set$: setSessionListCollapsedRaw$,
  clear$: clearSessionListCollapsed$,
} = localStorageSignals("sessionListCollapsed");
export const sessionListCollapsed$ = computed((get) => {
  return get(sessionListCollapsedRaw$) !== null;
});
export const setSessionListCollapsed$ = command(
  ({ set }, collapsed: boolean) => {
    if (collapsed) {
      set(setSessionListCollapsedRaw$, "1");
    } else {
      set(clearSessionListCollapsed$);
    }
  },
);

// ---------------------------------------------------------------------------
// Manage section collapse state (Sidebar) — persisted in localStorage
// ---------------------------------------------------------------------------
const {
  get$: manageSectionCollapsedRaw$,
  set$: setManageSectionCollapsedRaw$,
  clear$: clearManageSectionCollapsed$,
} = localStorageSignals("manageCollapsed");
export const manageSectionCollapsed$ = computed((get) => {
  return get(manageSectionCollapsedRaw$) !== null;
});
export const setManageSectionCollapsed$ = command(
  ({ set }, collapsed: boolean) => {
    if (collapsed) {
      set(setManageSectionCollapsedRaw$, "1");
    } else {
      set(clearManageSectionCollapsed$);
    }
  },
);

// ---------------------------------------------------------------------------
// Chat list dialog state (TalkToSection)
// ---------------------------------------------------------------------------
const internalChatListOpen$ = state(false);
export const chatListOpen$ = computed((get) => {
  return get(internalChatListOpen$);
});
export const setChatListOpen$ = command(({ set }, open: boolean) => {
  set(internalChatListOpen$, open);
});

export const openAgentListDialog$ = command(({ set }) => {
  set(internalChatListQuery$, "");
  set(internalChatListOpen$, true);
});

// ---------------------------------------------------------------------------
// Three-column search dialog state
// ---------------------------------------------------------------------------
export type ThreeColumnSearchFilter =
  | "all"
  | "chats"
  | "messages"
  | "workflows"
  | "artifacts";

const internalThreeColumnSearchOpen$ = state(false);
export const threeColumnSearchOpen$ = computed((get) => {
  return get(internalThreeColumnSearchOpen$);
});
export const setThreeColumnSearchOpen$ = command(({ set }, open: boolean) => {
  set(internalThreeColumnSearchOpen$, open);
});

const internalThreeColumnSearchFilter$ = state<ThreeColumnSearchFilter>("all");
export const threeColumnSearchFilter$ = computed((get) => {
  return get(internalThreeColumnSearchFilter$);
});
export const setThreeColumnSearchFilter$ = command(
  ({ set }, filter: ThreeColumnSearchFilter) => {
    set(internalThreeColumnSearchFilter$, filter);
  },
);

export const openThreeColumnSearchDialog$ = command(({ set }) => {
  set(internalChatListQuery$, "");
  set(internalThreeColumnSearchFilter$, "all");
  set(internalThreeColumnSearchOpen$, true);
});

// ---------------------------------------------------------------------------
// Pin agent dialog state (pinned agent grid)
// ---------------------------------------------------------------------------
const internalPinAgentDialogOpen$ = state(false);
export const pinAgentDialogOpen$ = computed((get) => {
  return get(internalPinAgentDialogOpen$);
});
export const setPinAgentDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalPinAgentDialogOpen$, open);
});

const internalPinAgentDialogQuery$ = state("");
export const pinAgentDialogQuery$ = computed((get) => {
  return get(internalPinAgentDialogQuery$);
});
export const setPinAgentDialogQuery$ = command(({ set }, query: string) => {
  set(internalPinAgentDialogQuery$, query);
});

export const openPinAgentDialog$ = command(({ set }) => {
  set(internalPinAgentDialogQuery$, "");
  set(internalPinAgentDialogOpen$, true);
});

// ---------------------------------------------------------------------------
// Pinned agent drag and drop state (pinned agent grid)
// ---------------------------------------------------------------------------
const internalDraggingPinnedAgentId$ = state<string | null>(null);
export const draggingPinnedAgentId$ = computed((get) => {
  return get(internalDraggingPinnedAgentId$);
});

const internalPinnedAgentDropTargetId$ = state<string | null>(null);
export const pinnedAgentDropTargetId$ = computed((get) => {
  return get(internalPinnedAgentDropTargetId$);
});

export const startPinnedAgentDrag$ = command(({ set }, agentId: string) => {
  set(internalDraggingPinnedAgentId$, agentId);
  set(internalPinnedAgentDropTargetId$, null);
});

export const setPinnedAgentDropTarget$ = command(
  ({ set }, agentId: string | null) => {
    set(internalPinnedAgentDropTargetId$, agentId);
  },
);

export const endPinnedAgentDrag$ = command(({ set }) => {
  set(internalDraggingPinnedAgentId$, null);
  set(internalPinnedAgentDropTargetId$, null);
});

// ---------------------------------------------------------------------------
// Agent card / pinned section collapse state (TalkToSection) — persisted in localStorage
// ---------------------------------------------------------------------------
const {
  get$: agentCardCollapsedRaw$,
  set$: setAgentCardCollapsedRaw$,
  clear$: clearAgentCardCollapsed$,
} = localStorageSignals("pinnedCollapsed");
export const agentCardCollapsed$ = computed((get) => {
  return get(agentCardCollapsedRaw$) !== null;
});
export const setAgentCardCollapsed$ = command(({ set }, collapsed: boolean) => {
  if (collapsed) {
    set(setAgentCardCollapsedRaw$, "1");
  } else {
    set(clearAgentCardCollapsed$);
  }
});

// ---------------------------------------------------------------------------
// Chat thread virtual list geometry (RecentChatSection)
// ---------------------------------------------------------------------------
export const CHAT_THREAD_VIRTUAL_ROW_HEIGHT = 36;
export const CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT =
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 12;
export type ChatThreadVirtualListScrollAlign = "top" | "bottom";

function hasUsableLayoutPosition(rect: DOMRectReadOnly): boolean {
  return rect.top !== 0 || rect.left !== 0;
}

export function getChatThreadVirtualListScrollMargin(
  scrollViewport: HTMLElement | null,
  virtualListElement: HTMLElement | null,
): number {
  if (!scrollViewport || !virtualListElement) {
    return 0;
  }

  const viewportRect = scrollViewport.getBoundingClientRect();
  const virtualListRect = virtualListElement.getBoundingClientRect();
  if (
    hasUsableLayoutPosition(viewportRect) ||
    hasUsableLayoutPosition(virtualListRect)
  ) {
    return Math.max(
      0,
      scrollViewport.scrollTop + virtualListRect.top - viewportRect.top,
    );
  }

  return Math.max(0, virtualListElement.offsetTop - scrollViewport.offsetTop);
}
