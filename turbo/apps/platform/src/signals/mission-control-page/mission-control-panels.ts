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
const internalMaximizedTaskId$ = state<string | null>(null);
const internalTaskListPanelRef$ = state<PanelImperativeHandle | null>(null);
const internalTaskGroupRef$ = state<GroupImperativeHandle | null>(null);
const internalPreMaximizeLayout$ = state<Layout | null>(null);

// ---------------------------------------------------------------------------
// Computed (read-only)
// ---------------------------------------------------------------------------

export const taskListCollapsed$ = computed((get) => {
  return get(internalTaskListCollapsed$);
});

export const maximizedTaskId$ = computed((get) => {
  return get(internalMaximizedTaskId$);
});

// ---------------------------------------------------------------------------
// Commands — ref registration
// ---------------------------------------------------------------------------

export const setTaskListPanelRef$ = command(
  ({ set }, ref: PanelImperativeHandle | null) => {
    set(internalTaskListPanelRef$, ref);
  },
);

export const setTaskGroupRef$ = command(
  ({ set }, ref: GroupImperativeHandle | null) => {
    set(internalTaskGroupRef$, ref);
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
// Commands — task maximize/restore
// ---------------------------------------------------------------------------

const maximizeTask$ = command(({ get, set }, taskId: string) => {
  const groupRef = get(internalTaskGroupRef$);
  if (!groupRef) {
    return;
  }

  const currentLayout = groupRef.getLayout();
  set(internalPreMaximizeLayout$, currentLayout);

  const newLayout: Layout = {};
  for (const panelId of Object.keys(currentLayout)) {
    newLayout[panelId] = panelId === `task-${taskId}` ? 100 : 0;
  }
  groupRef.setLayout(newLayout);
  set(internalMaximizedTaskId$, taskId);
});

const restoreTaskLayout$ = command(({ get, set }) => {
  const groupRef = get(internalTaskGroupRef$);
  const savedLayout = get(internalPreMaximizeLayout$);
  if (!groupRef || !savedLayout) {
    return;
  }
  groupRef.setLayout(savedLayout);
  set(internalMaximizedTaskId$, null);
  set(internalPreMaximizeLayout$, null);
});

export const toggleMaximizeTask$ = command(({ get, set }, taskId: string) => {
  if (get(internalMaximizedTaskId$) === taskId) {
    set(restoreTaskLayout$);
  } else {
    set(maximizeTask$, taskId);
  }
});
