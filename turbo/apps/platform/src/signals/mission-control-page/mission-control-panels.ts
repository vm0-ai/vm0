import { command, computed, state } from "ccstate";
import type { PanelImperativeHandle } from "react-resizable-panels";

// ---------------------------------------------------------------------------
// State atoms
// ---------------------------------------------------------------------------

const internalTaskListCollapsed$ = state(false);
const internalMaximizedTaskId$ = state<string | null>(null);
const internalTaskListPanelRef$ = state<PanelImperativeHandle | null>(null);
const internalActivePanelId$ = state<string | null>(null);

// ---------------------------------------------------------------------------
// Computed (read-only)
// ---------------------------------------------------------------------------

export const taskListCollapsed$ = computed((get) => {
  return get(internalTaskListCollapsed$);
});

export const maximizedTaskId$ = computed((get) => {
  return get(internalMaximizedTaskId$);
});

export const activePanelId$ = computed((get) => {
  return get(internalActivePanelId$);
});

// ---------------------------------------------------------------------------
// Commands — ref registration
// ---------------------------------------------------------------------------

export const setTaskListPanelRef$ = command(
  ({ set }, ref: PanelImperativeHandle | null) => {
    set(internalTaskListPanelRef$, ref);
  },
);

// ---------------------------------------------------------------------------
// Commands — TaskList collapse/expand
// ---------------------------------------------------------------------------

export const setTaskListCollapsed$ = command(({ set }, collapsed: boolean) => {
  set(internalTaskListCollapsed$, collapsed);
});

export const toggleTaskList$ = command(({ get }) => {
  const panelRef = get(internalTaskListPanelRef$);
  if (!panelRef) {
    return;
  }
  if (panelRef.isCollapsed()) {
    panelRef.expand();
  } else {
    panelRef.collapse();
  }
});

// ---------------------------------------------------------------------------
// Commands — active panel
// ---------------------------------------------------------------------------

export const setActivePanelId$ = command(({ set }, id: string | null) => {
  set(internalActivePanelId$, id);
});

// ---------------------------------------------------------------------------
// Commands — task maximize/restore
// ---------------------------------------------------------------------------

export const toggleMaximizeTask$ = command(({ get, set }, taskId: string) => {
  if (get(internalMaximizedTaskId$) === taskId) {
    set(internalMaximizedTaskId$, null);
  } else {
    set(internalMaximizedTaskId$, taskId);
  }
});
