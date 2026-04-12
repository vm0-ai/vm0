import { command, computed, state, type Command, type Computed } from "ccstate";
import { tasksContract, type TaskItem } from "@vm0/core";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept";
import { onRef, setLoop } from "../utils.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  type ChatThreadSignals,
} from "../chat-page/create-chat-thread.ts";
import {
  createActivitySignals,
  type ActivitySignals,
} from "./create-activity-signals.ts";
import { maximizedTaskId$ } from "./mission-control-panels.ts";

// ---------------------------------------------------------------------------
// TaskPanelEntry — discriminated union for open panels
// ---------------------------------------------------------------------------

export type TaskPanelEntry =
  | { kind: "chat"; signals: ChatThreadSignals }
  | { kind: "activity"; signals: ActivitySignals };

// ---------------------------------------------------------------------------
// TaskSignals — per-task signal bundle
// ---------------------------------------------------------------------------

export interface TaskSignals {
  task: TaskItem;
  open$: Computed<boolean>;
  openedAt$: Computed<number | null>;
  panelEntry$: Computed<TaskPanelEntry | null>;
  openTask$: Command<Promise<void>, [AbortSignal]>;
  closeTask$: Command<void, []>;
  focusInput$: Command<void, []>;
  setCardRef$: Command<void | (() => void), [HTMLElement | null]>;
  focusCard$: Command<void, []>;
  scrollCardIntoView$: Command<void, []>;
  inputFocused$: Computed<boolean>;
  setInputFocused$: Command<void, [boolean]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createTaskSignals(initialTask: TaskItem): TaskSignals {
  const internalOpen$ = state(false);
  const internalOpenedAt$ = state<number | null>(null);
  const internalPanelEntry$ = state<TaskPanelEntry | null>(null);

  const open$ = computed((get) => {
    return get(internalOpen$);
  });

  const openedAt$ = computed((get) => {
    return get(internalOpenedAt$);
  });

  const panelEntry$ = computed((get) => {
    return get(internalPanelEntry$);
  });

  const closeTask$ = command(({ set }) => {
    set(internalOpen$, false);
    set(internalOpenedAt$, null);
    set(internalPanelEntry$, null);
    set(internalInputFocused$, false);
  });

  // Mutable ref so openTask$ always reads the latest API data
  const taskRef = { value: initialTask };

  const openTask$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (get(internalOpen$)) {
        return;
      }

      const task = taskRef.value;

      if (task.type === "chat" && task.chatThreadId) {
        const draft = set(ensureDraft$, task.chatThreadId);
        const signals = createChatThreadSignals(task.chatThreadId, draft);
        set(internalPanelEntry$, { kind: "chat", signals });
        set(internalOpenedAt$, Date.now());
        set(internalOpen$, true);
        await set(signals.loadMessages$, signal);
        return;
      }

      if (task.latestRunId) {
        const signals = createActivitySignals(task.latestRunId);
        set(internalPanelEntry$, { kind: "activity", signals });
        set(internalOpenedAt$, Date.now());
        set(internalOpen$, true);
        await set(signals.startPolling$, signal);
      }
    },
  );

  const focusInput$ = command(({ get, set }) => {
    const entry = get(internalPanelEntry$);
    if (entry) {
      set(entry.signals.focusInput$);
    }
  });

  const internalCardRef$ = state<HTMLElement | null>(null);
  const setCardRef$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(internalCardRef$, null);
      });
      set(internalCardRef$, el);
    }),
  );
  const scrollCardIntoView$ = command(({ get }) => {
    const el = get(internalCardRef$);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
  const focusCard$ = command(({ get, set }) => {
    set(scrollCardIntoView$);
    get(internalCardRef$)?.focus();
  });

  const internalInputFocused$ = state(false);
  const inputFocused$ = computed((get) => {
    return get(internalInputFocused$);
  });
  const setInputFocused$ = command(({ set }, focused: boolean) => {
    set(internalInputFocused$, focused);
  });

  return {
    get task() {
      return taskRef.value;
    },
    set task(t: TaskItem) {
      taskRef.value = t;
    },
    open$,
    openedAt$,
    panelEntry$,
    openTask$,
    closeTask$,
    focusInput$,
    setCardRef$,
    focusCard$,
    scrollCardIntoView$,
    inputFocused$,
    setInputFocused$,
  };
}

// ---------------------------------------------------------------------------
// Cache + reconciliation (follows memberCapSettingCache$ pattern)
// ---------------------------------------------------------------------------

const internalReloadTasks$ = state(0);

const reloadTasks$ = command(({ set }) => {
  set(internalReloadTasks$, (x) => {
    return x + 1;
  });
});

const tasks$ = computed(async (get) => {
  get(internalReloadTasks$);

  const client = get(zeroClient$)(tasksContract);
  const result = await accept(client.list({ query: {} }), [200]);
  const tasks = result.body.tasks;

  return tasks;
});

const internalTaskSignals$ = state<Map<string, TaskSignals>>(new Map());

export const setupTasksLoop$ = command(
  async ({ set, get }, signal: AbortSignal) => {
    await setLoop(
      async () => {
        set(reloadTasks$);
        const tasks = await get(tasks$);
        signal.throwIfAborted();

        const taskIds = new Set(
          tasks.map((t) => {
            return t.id;
          }),
        );

        const taskSignals = new Map(get(internalTaskSignals$));

        // Prune stale entries
        for (const [id, ts] of taskSignals) {
          if (!taskIds.has(id)) {
            set(ts.closeTask$);
            taskSignals.delete(id);
          }
        }

        // Add new entries
        for (const task of tasks) {
          const existing = taskSignals.get(task.id);
          if (existing) {
            existing.task = task;
          } else {
            taskSignals.set(task.id, createTaskSignals(task));
          }
        }

        set(internalTaskSignals$, taskSignals);

        return false;
      },
      10_000,
      signal,
    );
  },
);

/**
 * Ordered list of TaskSignals derived from the reconciled cache.
 * Matches the order of the latest tasks$ fetch.
 */
export const taskSignals$ = computed(async (get) => {
  const tasks = await get(tasks$);
  const taskSignals = get(internalTaskSignals$);

  return tasks
    .map((task) => {
      return taskSignals.get(task.id);
    })
    .filter((ts): ts is TaskSignals => {
      return ts !== undefined;
    });
});

// ---------------------------------------------------------------------------
// Cross-task commands
// ---------------------------------------------------------------------------

export const closeAndFocusNextInput$ = command(
  async ({ get, set }, taskId: string, _signal: AbortSignal) => {
    const tasks = await get(taskSignals$);
    const currentIndex = tasks.findIndex((ts) => {
      return ts.task.id === taskId;
    });
    if (currentIndex === -1) {
      return;
    }

    set(tasks[currentIndex].closeTask$);

    for (let i = 1; i < tasks.length; i++) {
      const idx = (currentIndex + i) % tasks.length;
      if (get(tasks[idx].open$)) {
        set(tasks[idx].focusInput$);
        return;
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Derived computeds
// ---------------------------------------------------------------------------

/**
 * Visible task panels. When a task is maximized, returns only that task.
 * Otherwise returns all open tasks.
 */
export const visibleTasks$ = computed(async (get) => {
  const all = await get(taskSignals$);
  const open = all
    .filter((ts) => {
      return get(ts.open$);
    })
    .sort((a, b) => {
      return (get(a.openedAt$) ?? 0) - (get(b.openedAt$) ?? 0);
    });

  const maximizedId = get(maximizedTaskId$);
  if (maximizedId !== null) {
    const maximized = open.find((ts) => {
      return ts.task.id === maximizedId;
    });
    return maximized ? [maximized] : open;
  }

  return open;
});

/**
 * Whether the Mission Control task panel area is visible.
 * True when at least one task is open.
 */
export const missionControlPanelVisible$ = computed(async (get) => {
  const visible = await get(visibleTasks$);
  return visible.length > 0;
});
