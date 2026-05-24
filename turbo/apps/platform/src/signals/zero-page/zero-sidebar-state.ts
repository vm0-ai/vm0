import { command, computed, state } from "ccstate";
import { localStorageSignals } from "../external/local-storage.ts";

// ---------------------------------------------------------------------------
// Manage pinned agents dialog state
// ---------------------------------------------------------------------------
const internalManagePinnedOpen$ = state(false);
export const managePinnedDialogOpen$ = computed((get) => {
  return get(internalManagePinnedOpen$);
});
export const setManagePinnedDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalManagePinnedOpen$, open);
});

// ---------------------------------------------------------------------------
// Draft pinned IDs (for dialog editing before save)
// ---------------------------------------------------------------------------
const internalDraftPinnedIds$ = state<string[]>([]);
export const draftPinnedIds$ = computed((get) => {
  return get(internalDraftPinnedIds$);
});
export const setDraftPinnedIds$ = command(({ set }, ids: string[]) => {
  set(internalDraftPinnedIds$, ids);
});

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
const internalRenameDialogThreadId$ = state<string | null>(null);
export const renameDialogThreadId$ = computed((get) => {
  return get(internalRenameDialogThreadId$);
});
export const setRenameDialogThreadId$ = command(
  ({ set }, id: string | null) => {
    set(internalRenameDialogThreadId$, id);
  },
);

const internalRenameDialogInput$ = state("");
export const renameDialogInput$ = computed((get) => {
  return get(internalRenameDialogInput$);
});
export const setRenameDialogInput$ = command(({ set }, input: string) => {
  set(internalRenameDialogInput$, input);
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
// Scrollbar hover state (OverlayScrollArea)
// ---------------------------------------------------------------------------
const internalHovering$ = state(false);
export const hovering$ = computed((get) => {
  return get(internalHovering$);
});
export const setHovering$ = command(({ set }, hovering: boolean) => {
  set(internalHovering$, hovering);
});

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
