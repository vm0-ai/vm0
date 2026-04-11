import { command, computed, state } from "ccstate";
import type {
  PanelImperativeHandle,
  GroupImperativeHandle,
  Layout,
} from "react-resizable-panels";

// ---------------------------------------------------------------------------
// State atoms
// ---------------------------------------------------------------------------

const internalTaskListCollapsed$ = state(false);
const internalMaximizedThreadId$ = state<string | null>(null);
const internalTaskListPanelRef$ = state<PanelImperativeHandle | null>(null);
const internalThreadGroupRef$ = state<GroupImperativeHandle | null>(null);
const internalPreMaximizeLayout$ = state<Layout | null>(null);

// ---------------------------------------------------------------------------
// Computed (read-only)
// ---------------------------------------------------------------------------

export const taskListCollapsed$ = computed((get) => {
  return get(internalTaskListCollapsed$);
});

export const maximizedThreadId$ = computed((get) => {
  return get(internalMaximizedThreadId$);
});

// ---------------------------------------------------------------------------
// Commands — ref registration
// ---------------------------------------------------------------------------

export const setTaskListPanelRef$ = command(
  ({ set }, ref: PanelImperativeHandle | null) => {
    set(internalTaskListPanelRef$, ref);
  },
);

export const setThreadGroupRef$ = command(
  ({ set }, ref: GroupImperativeHandle | null) => {
    set(internalThreadGroupRef$, ref);
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
// Commands — thread maximize/restore
// ---------------------------------------------------------------------------

const maximizeThread$ = command(({ get, set }, threadId: string) => {
  const groupRef = get(internalThreadGroupRef$);
  if (!groupRef) {
    return;
  }

  const currentLayout = groupRef.getLayout();
  set(internalPreMaximizeLayout$, currentLayout);

  const newLayout: Layout = {};
  for (const panelId of Object.keys(currentLayout)) {
    newLayout[panelId] = panelId === `thread-${threadId}` ? 100 : 0;
  }
  groupRef.setLayout(newLayout);
  set(internalMaximizedThreadId$, threadId);
});

const restoreThreadLayout$ = command(({ get, set }) => {
  const groupRef = get(internalThreadGroupRef$);
  const savedLayout = get(internalPreMaximizeLayout$);
  if (!groupRef || !savedLayout) {
    return;
  }
  groupRef.setLayout(savedLayout);
  set(internalMaximizedThreadId$, null);
  set(internalPreMaximizeLayout$, null);
});

export const toggleMaximizeThread$ = command(
  ({ get, set }, threadId: string) => {
    if (get(internalMaximizedThreadId$) === threadId) {
      set(restoreThreadLayout$);
    } else {
      set(maximizeThread$, threadId);
    }
  },
);
