import { command, computed, state } from "ccstate";

// ---------------------------------------------------------------------------
// Sidebar search state
// ---------------------------------------------------------------------------
const internalThreadSearchOpen$ = state(false);
export const threadSearchOpen$ = computed((get) => {
  return get(internalThreadSearchOpen$);
});

const internalThreadSearchTerm$ = state("");
export const sidebarSearchTerm$ = computed((get) => {
  return get(internalThreadSearchTerm$);
});

export const setThreadSearchOpen$ = command(({ set }, open: boolean) => {
  set(internalThreadSearchOpen$, open);
  if (!open) {
    set(internalThreadSearchTerm$, "");
  }
});

export const setThreadSearchTerm$ = command(({ set }, term: string) => {
  set(internalThreadSearchTerm$, term);
});

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
// Session list collapse state (RecentChatSection)
// ---------------------------------------------------------------------------
const internalSessionListCollapsed$ = state(false);
export const sessionListCollapsed$ = computed((get) => {
  return get(internalSessionListCollapsed$);
});
export const setSessionListCollapsed$ = command(
  ({ set }, collapsed: boolean) => {
    set(internalSessionListCollapsed$, collapsed);
  },
);

// ---------------------------------------------------------------------------
// Manage section collapse state (ZeroSidebar)
// ---------------------------------------------------------------------------
const internalManageSectionCollapsed$ = state(false);
export const manageSectionCollapsed$ = computed((get) => {
  return get(internalManageSectionCollapsed$);
});
export const setManageSectionCollapsed$ = command(
  ({ set }, collapsed: boolean) => {
    set(internalManageSectionCollapsed$, collapsed);
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
// Agent card / pinned section collapse state (TalkToSection)
// ---------------------------------------------------------------------------
const internalAgentCardCollapsed$ = state(false);
export const agentCardCollapsed$ = computed((get) => {
  return get(internalAgentCardCollapsed$);
});
export const setAgentCardCollapsed$ = command(({ set }, collapsed: boolean) => {
  set(internalAgentCardCollapsed$, collapsed);
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
