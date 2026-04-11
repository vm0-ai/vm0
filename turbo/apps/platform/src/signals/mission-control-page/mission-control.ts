import { command, computed, state } from "ccstate";
import { toggleTaskList$ } from "./mission-control-panels.ts";
import { taskSignals$, setupTasksLoop$ } from "./mission-control-tasks.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";

// ---------------------------------------------------------------------------
// Selection — id-based
// ---------------------------------------------------------------------------

const internalSelectedTaskId$ = state<string | null>(null);

export const selectedTaskId$ = computed((get) => {
  return get(internalSelectedTaskId$);
});

const selectPrevTask$ = command(async ({ get, set }, signal: AbortSignal) => {
  const tasks = await get(taskSignals$);
  signal.throwIfAborted();

  if (tasks.length === 0) {
    return;
  }

  const currentId = get(internalSelectedTaskId$);
  const currentIndex = tasks.findIndex((ts) => {
    return ts.task.id === currentId;
  });

  if (currentIndex <= 0) {
    set(internalSelectedTaskId$, tasks[0].task.id);
  } else {
    set(internalSelectedTaskId$, tasks[currentIndex - 1].task.id);
  }
});

const selectNextTask$ = command(async ({ get, set }, signal: AbortSignal) => {
  const tasks = await get(taskSignals$);
  signal.throwIfAborted();

  if (tasks.length === 0) {
    return;
  }

  const currentId = get(internalSelectedTaskId$);
  const currentIndex = tasks.findIndex((ts) => {
    return ts.task.id === currentId;
  });

  if (currentIndex === -1 || currentIndex >= tasks.length - 1) {
    set(internalSelectedTaskId$, tasks[tasks.length - 1].task.id);
  } else {
    set(internalSelectedTaskId$, tasks[currentIndex + 1].task.id);
  }
});

const toggleSelectedTask$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const tasks = await get(taskSignals$);
    signal.throwIfAborted();

    const selectedId = get(internalSelectedTaskId$);
    const ts = tasks.find((t) => {
      return t.task.id === selectedId;
    });
    if (!ts) {
      return;
    }

    if (get(ts.open$)) {
      set(ts.closeTask$);
    } else {
      await set(ts.openTask$, signal);
    }
  },
);

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

export const setupMissionControlKeyboard$ = command(
  ({ set }, signal: AbortSignal) => {
    setupGlobalShortcut(
      {
        k: async () => {
          await set(selectPrevTask$, signal);
        },
        j: async () => {
          await set(selectNextTask$, signal);
        },
        " ": async () => {
          await set(toggleSelectedTask$, signal);
        },
        "mod+b": () => {
          set(toggleTaskList$);
        },
      },
      signal,
    );
  },
);

// ---------------------------------------------------------------------------
// Polling loop — reload tasks every 10s
// ---------------------------------------------------------------------------

export const setupMissionControlLoop$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(setupTasksLoop$, signal);
  },
);
