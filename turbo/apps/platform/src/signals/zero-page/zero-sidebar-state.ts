import { command, computed, state } from "ccstate";
import { localStorageSignals } from "../external/local-storage.ts";
import { onDomEventFn, onRef } from "../utils.ts";

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
// Manage section collapse state (ZeroSidebar) — persisted in localStorage
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
export type ThreeColumnSearchFilter = "all" | "chats" | "messages";

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
// Pinned agent grid rows (three-column sidebar) — persisted in localStorage
// ---------------------------------------------------------------------------
export const PINNED_AGENT_GRID_COLUMNS = 5;

const { get$: pinnedAgentGridRowsRaw$, set$: setPinnedAgentGridRowsRaw$ } =
  localStorageSignals("pinnedAgentGridRows");
export const pinnedAgentGridRows$ = computed((get) => {
  const rows = Number(get(pinnedAgentGridRowsRaw$));
  return Number.isSafeInteger(rows) && rows > 0 ? rows : 1;
});
const cachePinnedAgentGridRowsFromElement$ = command(
  ({ get, set }, element: HTMLDivElement) => {
    const rows = Math.max(
      1,
      Math.ceil(element.childElementCount / PINNED_AGENT_GRID_COLUMNS),
    );
    const next = String(rows);
    if (get(pinnedAgentGridRowsRaw$) === next) {
      return;
    }
    set(setPinnedAgentGridRowsRaw$, next);
  },
);
export const cachePinnedAgentGridRowsRef$ = onRef(
  command(({ set }, element: HTMLDivElement, signal: AbortSignal) => {
    set(cachePinnedAgentGridRowsFromElement$, element);
    const observer = new MutationObserver(
      onDomEventFn(() => {
        set(cachePinnedAgentGridRowsFromElement$, element);
      }),
    );
    observer.observe(element, { childList: true });
    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
  }),
);

// ---------------------------------------------------------------------------
// Custom scrollbar thumb style (OverlayScrollArea)
// ---------------------------------------------------------------------------
interface ThumbStyle {
  top: number;
  height: number;
  visible: boolean;
}
const internalThumbStyle$ = state<ThumbStyle>({
  top: 0,
  height: 0,
  visible: false,
});
export const thumbStyle$ = computed((get) => {
  return get(internalThumbStyle$);
});
export const setThumbStyle$ = command(({ set }, style: ThumbStyle) => {
  set(internalThumbStyle$, style);
});

// ---------------------------------------------------------------------------
// Overlay scroll viewport (OverlayScrollArea)
// ---------------------------------------------------------------------------
const internalOverlayScrollViewport$ = state<HTMLElement | null>(null);
interface OverlayScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const internalOverlayScrollMetrics$ = state<OverlayScrollMetrics>(
  emptyOverlayScrollMetrics(),
);

function emptyOverlayScrollMetrics(): OverlayScrollMetrics {
  return {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
}

export const overlayScrollViewport$ = computed((get) => {
  return get(internalOverlayScrollViewport$);
});
export const overlayScrollMetrics$ = computed((get) => {
  return get(internalOverlayScrollMetrics$);
});
export const setOverlayScrollViewport$ = command(
  ({ set }, viewport: HTMLElement | null) => {
    set(internalOverlayScrollViewport$, viewport);
    set(
      internalOverlayScrollMetrics$,
      viewport
        ? {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
          }
        : emptyOverlayScrollMetrics(),
    );
  },
);
export const setOverlayScrollMetrics$ = command(
  ({ set }, metrics: OverlayScrollMetrics) => {
    set(internalOverlayScrollMetrics$, metrics);
  },
);

// ---------------------------------------------------------------------------
// Chat thread virtual list DOM state (RecentChatSection)
// ---------------------------------------------------------------------------
export const CHAT_THREAD_VIRTUAL_ROW_HEIGHT = 36;
export const CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT =
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 12;
const internalChatThreadVirtualListElement$ = state<HTMLElement | null>(null);
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

export const chatThreadVirtualListElement$ = computed((get) => {
  return get(internalChatThreadVirtualListElement$);
});
export const setChatThreadVirtualListElement$ = command(
  ({ set }, element: HTMLElement | null) => {
    set(internalChatThreadVirtualListElement$, element);
  },
);
export const scrollChatThreadVirtualListToIndex$ = command(
  (
    { get, set },
    index: number,
    align: ChatThreadVirtualListScrollAlign = "top",
  ): boolean => {
    if (!Number.isInteger(index) || index < 0) {
      return false;
    }

    const scrollViewport = get(internalOverlayScrollViewport$);
    const virtualListElement = get(internalChatThreadVirtualListElement$);
    if (!scrollViewport || !virtualListElement) {
      return false;
    }

    const currentMetrics = get(internalOverlayScrollMetrics$);
    const scrollMargin = getChatThreadVirtualListScrollMargin(
      scrollViewport,
      virtualListElement,
    );
    const viewportHeight =
      currentMetrics.clientHeight ||
      scrollViewport.clientHeight ||
      CHAT_THREAD_VIRTUAL_FALLBACK_VIEWPORT_HEIGHT;
    const rowTop = scrollMargin + index * CHAT_THREAD_VIRTUAL_ROW_HEIGHT;
    const rowBottom = rowTop + CHAT_THREAD_VIRTUAL_ROW_HEIGHT;
    const viewportTop = scrollViewport.scrollTop;
    const viewportBottom = viewportTop + viewportHeight;
    let nextScrollTop = viewportTop;
    if (rowBottom > viewportBottom) {
      nextScrollTop =
        align === "bottom"
          ? Math.max(0, rowBottom - viewportHeight)
          : Math.max(0, rowTop);
    } else if (rowTop < viewportTop) {
      nextScrollTop = Math.max(0, rowTop);
    }

    scrollViewport.scrollTop = nextScrollTop;
    set(internalOverlayScrollMetrics$, {
      scrollTop: nextScrollTop,
      scrollHeight: scrollViewport.scrollHeight,
      clientHeight: scrollViewport.clientHeight,
    });
    return true;
  },
);

// ---------------------------------------------------------------------------
// Main sidebar scroll tracking (ZeroSidebar)
// ---------------------------------------------------------------------------
const internalIsScrolled$ = state(false);
export const isScrolled$ = computed((get) => {
  return get(internalIsScrolled$);
});
export const setIsScrolled$ = command(({ set }, scrolled: boolean) => {
  set(internalIsScrolled$, scrolled);
});
