import { command, computed, state, type Command, type Computed } from "ccstate";
import { tasksContract, type TaskItem } from "@vm0/core";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept";
import { jsonParseOr, onRef, resetSignal, throwIfNotAbort } from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { clerk$ } from "../auth.ts";
import {
  createChatThreadSignals,
  ensureDraft$,
  type ChatThreadSignals,
} from "../chat-page/create-chat-thread.ts";
import {
  createActivitySignals,
  type ActivitySignals,
} from "./create-activity-signals.ts";
import {
  createVoiceChatPanelSignals,
  type VoiceChatPanelSignals,
} from "./create-voice-chat-panel-signals.ts";
import {
  maximizedTaskId$,
  setActivePanelId$,
} from "./mission-control-panels.ts";
import { localStorageSignals } from "../external/local-storage.ts";

// ---------------------------------------------------------------------------
// Unread tracking — localStorage-backed map of taskId → lastSeenRunId
// ---------------------------------------------------------------------------

const lastSeenRunIdsStorage = localStorageSignals(
  "missionControlLastSeenRunIds",
);

const lastSeenRunIds$ = computed((get) => {
  const raw = get(lastSeenRunIdsStorage.get$);
  if (!raw) {
    return {} as Record<string, string>;
  }
  return jsonParseOr<Record<string, string>>(raw, {});
});

const OPTIMISTIC_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// TaskPanelEntry — discriminated union for open panels
// ---------------------------------------------------------------------------

export type TaskPanelEntry =
  | { kind: "chat"; signals: ChatThreadSignals }
  | { kind: "activity"; signals: ActivitySignals }
  | { kind: "voice"; signals: VoiceChatPanelSignals };

// ---------------------------------------------------------------------------
// TaskSignals — per-task signal bundle
// ---------------------------------------------------------------------------

export interface TaskSignals {
  taskId: string;
  task$: Computed<TaskItem>;
  updateTask$: Command<void, [TaskItem]>;
  unread$: Computed<boolean>;
  optimistic: boolean;
  optimisticInsertedAt: number | null;
  open$: Computed<boolean>;
  openedAt$: Computed<number | null>;
  panelEntry$: Computed<TaskPanelEntry | null>;
  openTask$: Command<Promise<void>, [AbortSignal]>;
  closeTask$: Command<void, []>;
  refreshPanel$: Command<void, [AbortSignal]>;
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

const markRead$ = command(
  ({ get, set }, taskId: string, latestRunId: string | null) => {
    if (!latestRunId) {
      return;
    }
    const seen = get(lastSeenRunIds$);
    if (seen[taskId] === latestRunId) {
      return;
    }
    set(
      lastSeenRunIdsStorage.set$,
      JSON.stringify({ ...seen, [taskId]: latestRunId }),
    );
  },
);

function createCardSignals() {
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
    setCardRef$,
    focusCard$,
    scrollCardIntoView$,
    inputFocused$,
    setInputFocused$,
  };
}

interface PanelSignals {
  open$: Computed<boolean>;
  openedAt$: Computed<number | null>;
  panelEntry$: Computed<TaskPanelEntry | null>;
  openTask$: Command<Promise<void>, [AbortSignal]>;
  closeTask$: Command<void, []>;
  refreshPanel$: Command<void, [AbortSignal]>;
  focusInput$: Command<void, []>;
}

function createPanelSignals(
  taskId: string,
  internalTask$: ReturnType<typeof state<TaskItem>>,
  setInputFocused$: Command<void, [boolean]>,
): PanelSignals {
  const internalOpen$ = state(false);
  const internalOpenedAt$ = state<number | null>(null);
  const internalPanelEntry$ = state<TaskPanelEntry | null>(null);
  const resetPanelPolling$ = resetSignal();

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
    set(resetPanelPolling$);
    set(internalOpen$, false);
    set(internalOpenedAt$, null);
    set(internalPanelEntry$, null);
    set(setInputFocused$, false);
  });

  const refreshPanel$ = command(({ get, set }, signal: AbortSignal) => {
    const entry = get(internalPanelEntry$);
    if (!entry || entry.kind !== "activity") {
      return;
    }
    const task = get(internalTask$);
    if (!task.latestRunId || entry.signals.runId === task.latestRunId) {
      return;
    }
    const panelSignal = set(resetPanelPolling$, signal);
    const signals = createActivitySignals(task.latestRunId);
    set(internalPanelEntry$, { kind: "activity", signals });
    // Polling lifecycle is managed by resetPanelPolling$ — aborted on next
    // refresh or panel close. throwIfNotAbort swallows the expected AbortError.
    set(signals.startPolling$, panelSignal).catch(throwIfNotAbort);
  });

  const openTask$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (get(internalOpen$)) {
        return;
      }
      const task = get(internalTask$);
      set(markRead$, taskId, task.latestRunId);
      if (task.type === "chat" && task.chatThreadId) {
        const { draft } = set(ensureDraft$, task.chatThreadId);
        const signals = createChatThreadSignals(task.chatThreadId, draft);
        set(internalPanelEntry$, { kind: "chat", signals });
        set(internalOpenedAt$, Date.now());
        set(internalOpen$, true);
        set(setActivePanelId$, taskId);
        await set(signals.loadMessages$, signal);
        return;
      }
      if (task.type === "voice_chat" && task.voiceChatSessionId) {
        const panelSignal = set(resetPanelPolling$, signal);
        const signals = createVoiceChatPanelSignals(task.voiceChatSessionId);
        set(internalPanelEntry$, { kind: "voice", signals });
        set(internalOpenedAt$, Date.now());
        set(internalOpen$, true);
        set(setActivePanelId$, taskId);
        await set(signals.startPolling$, panelSignal);
      } else if (task.latestRunId) {
        const panelSignal = set(resetPanelPolling$, signal);
        const signals = createActivitySignals(task.latestRunId);
        set(internalPanelEntry$, { kind: "activity", signals });
        set(internalOpenedAt$, Date.now());
        set(internalOpen$, true);
        set(setActivePanelId$, taskId);
        await set(signals.startPolling$, panelSignal);
      }
    },
  );

  const focusInput$ = command(({ get, set }) => {
    const entry = get(internalPanelEntry$);
    if (entry) {
      set(entry.signals.focusInput$);
    }
  });

  return {
    open$,
    openedAt$,
    panelEntry$,
    openTask$,
    closeTask$,
    refreshPanel$,
    focusInput$,
  };
}

function createTaskSignals(initialTask: TaskItem): TaskSignals {
  const internalTask$ = state(initialTask);

  const task$ = computed((get) => {
    return get(internalTask$);
  });

  const updateTask$ = command(({ set }, task: TaskItem) => {
    set(internalTask$, task);
  });

  const unread$ = computed((get) => {
    const task = get(internalTask$);
    if (!task.latestRunId) {
      return false;
    }
    const seen = get(lastSeenRunIds$);
    return seen[initialTask.id] !== task.latestRunId;
  });

  const {
    setCardRef$,
    focusCard$,
    scrollCardIntoView$,
    inputFocused$,
    setInputFocused$,
  } = createCardSignals();

  const {
    open$,
    openedAt$,
    panelEntry$,
    openTask$,
    closeTask$,
    refreshPanel$,
    focusInput$,
  } = createPanelSignals(initialTask.id, internalTask$, setInputFocused$);

  const optimisticRef = { value: false };
  const optimisticInsertedAtRef = { value: null as number | null };

  return {
    taskId: initialTask.id,
    task$,
    updateTask$,
    unread$,
    get optimistic() {
      return optimisticRef.value;
    },
    set optimistic(v: boolean) {
      optimisticRef.value = v;
    },
    get optimisticInsertedAt() {
      return optimisticInsertedAtRef.value;
    },
    set optimisticInsertedAt(v: number | null) {
      optimisticInsertedAtRef.value = v;
    },
    open$,
    openedAt$,
    panelEntry$,
    openTask$,
    closeTask$,
    refreshPanel$,
    focusInput$,
    setCardRef$,
    focusCard$,
    scrollCardIntoView$,
    inputFocused$,
    setInputFocused$,
  };
}

// ---------------------------------------------------------------------------
// Optimistic archive — client-side set of archived run IDs
// ---------------------------------------------------------------------------

const internalArchivedRunIds$ = state<Set<string>>(new Set());

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
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const orgId = clerk.organization?.id;
    if (!orgId) {
      throw new Error("setupTasksLoop$ called without active organization");
    }

    const tasksLoopBody$ = command(
      async ({ get, set }, signal: AbortSignal) => {
        set(reloadTasks$);
        const tasks = await get(tasks$);
        signal.throwIfAborted();

        const taskIds = new Set(
          tasks.map((t) => {
            return t.id;
          }),
        );

        const taskSignals = new Map(get(internalTaskSignals$));

        // Prune stale entries (skip optimistic entries — server hasn't confirmed yet)
        for (const [id, ts] of taskSignals) {
          if (taskIds.has(id)) {
            continue;
          }
          if (ts.optimistic) {
            continue;
          }
          set(ts.closeTask$);
          taskSignals.delete(id);
        }

        // Add new entries, clearing optimistic flag when server confirms
        for (const task of tasks) {
          const existing = taskSignals.get(task.id);
          if (existing) {
            set(existing.updateTask$, task);
            existing.optimistic = false;
            existing.optimisticInsertedAt = null;
            // Refresh activity panel when latestRunId changes, then mark read
            if (get(existing.open$)) {
              set(existing.refreshPanel$, signal);
              set(markRead$, task.id, task.latestRunId);
            }
          } else {
            taskSignals.set(task.id, createTaskSignals(task));
          }
        }

        // TTL prune: remove stale optimistic entries that were never confirmed
        const now = Date.now();
        for (const [id, ts] of taskSignals) {
          if (
            ts.optimistic &&
            ts.optimisticInsertedAt !== null &&
            now - ts.optimisticInsertedAt > OPTIMISTIC_TTL_MS
          ) {
            set(ts.closeTask$);
            taskSignals.delete(id);
          }
        }

        set(internalTaskSignals$, taskSignals);

        // Reconcile optimistic archived run IDs: once the server no longer
        // returns a task with a given runId, the archive has been confirmed and
        // the ID can be removed from the client-side filter set.
        const serverRunIds = new Set(
          tasks
            .map((t) => {
              return t.latestRunId;
            })
            .filter((id): id is string => {
              return id !== null;
            }),
        );
        const currentArchived = get(internalArchivedRunIds$);
        if (currentArchived.size > 0) {
          const stillPending = new Set(
            [...currentArchived].filter((id) => {
              return serverRunIds.has(id);
            }),
          );
          if (stillPending.size !== currentArchived.size) {
            set(internalArchivedRunIds$, stillPending);
          }
        }

        return false;
      },
    );

    await set(setAblyLoop$, `tasks:${orgId}`, tasksLoopBody$, 10_000, signal);
  },
);

/**
 * Ordered list of TaskSignals derived from the reconciled cache.
 * Optimistic entries (not yet confirmed by server) are prepended at the top.
 * Server-confirmed entries follow in server order.
 * Tasks whose latestRunId is in the archived set are excluded.
 */
export const taskSignals$ = computed(async (get) => {
  const tasks = await get(tasks$);
  const signals = get(internalTaskSignals$);
  const archivedRunIds = get(internalArchivedRunIds$);
  const serverIds = new Set(
    tasks.map((t) => {
      return t.id;
    }),
  );

  // Optimistic entries not yet confirmed by server — prepend at top
  const optimisticEntries = [...signals.values()].filter((ts) => {
    return ts.optimistic && !serverIds.has(ts.taskId);
  });

  // Server-confirmed entries in server order, excluding optimistically archived tasks
  const serverEntries = tasks
    .filter((task) => {
      return !task.latestRunId || !archivedRunIds.has(task.latestRunId);
    })
    .map((task) => {
      return signals.get(task.id);
    })
    .filter((ts): ts is TaskSignals => {
      return ts !== undefined;
    });

  return [...optimisticEntries, ...serverEntries];
});

// ---------------------------------------------------------------------------
// Archive command
// ---------------------------------------------------------------------------

const archiveTask$ = command(
  async ({ get, set }, taskId: string, _signal: AbortSignal): Promise<void> => {
    const taskSignals = get(internalTaskSignals$);
    const ts = taskSignals.get(taskId);
    if (!ts) {
      return;
    }

    const task = get(ts.task$);
    const client = get(zeroClient$)(tasksContract);

    await accept(
      client.archive({
        body: {
          taskId: task.id,
          taskType: task.type,
          runId: task.latestRunId,
        },
      }),
      [200],
    );

    // Optimistic removal: close panel and remove from cache immediately
    set(ts.closeTask$);
    const updated = new Map(get(internalTaskSignals$));
    updated.delete(taskId);
    set(internalTaskSignals$, updated);
  },
);

// ---------------------------------------------------------------------------
// Optimistic task insertion
// ---------------------------------------------------------------------------

/**
 * Insert an optimistic task entry for a newly created chat thread.
 * If an entry already exists for this threadId, returns the existing entry (no-op).
 * The entry is protected from pruning until the server confirms it (or TTL expires).
 */
export const addOptimisticTask$ = command(
  (
    { get, set },
    agentId: string,
    threadId: string,
    agentDisplayName: string | null,
    agentAvatarUrl: string | null,
  ): TaskSignals => {
    const existing = get(internalTaskSignals$).get(threadId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const syntheticTask: TaskItem = {
      id: threadId,
      type: "chat",
      title: null,
      summary: null,
      agent: {
        id: agentId,
        name: agentId,
        displayName: agentDisplayName,
        avatarUrl: agentAvatarUrl,
      },
      latestRunId: null,
      status: null,
      chatThreadId: threadId,
      createdAt: now,
      updatedAt: now,
    };

    const ts = createTaskSignals(syntheticTask);
    ts.optimistic = true;
    ts.optimisticInsertedAt = Date.now();

    const updated = new Map(get(internalTaskSignals$));
    updated.set(threadId, ts);
    set(internalTaskSignals$, updated);

    return ts;
  },
);

// ---------------------------------------------------------------------------
// Lookup by task ID (sync — used by global keyboard shortcuts)
// ---------------------------------------------------------------------------

export const focusTaskCard$ = command(({ get, set }, taskId: string) => {
  const ts = get(internalTaskSignals$).get(taskId);
  if (ts) {
    set(ts.focusCard$);
  }
});

// ---------------------------------------------------------------------------
// Cross-task commands
// ---------------------------------------------------------------------------

export const closeAndFocusNextInput$ = command(
  async ({ get, set }, taskId: string, _signal: AbortSignal) => {
    const tasks = await get(taskSignals$);
    const currentIndex = tasks.findIndex((ts) => {
      return ts.taskId === taskId;
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

/**
 * Optimistically archive a task by its latestRunId and focus the next card.
 * The card disappears immediately from the UI, and the archive request is sent
 * to the server in the background. The optimistic filter is cleared once the
 * server confirms the task is gone (reconciliation in setupTasksLoop$).
 */
export const archiveAndFocusNext$ = command(
  async ({ get, set }, taskId: string, signal: AbortSignal) => {
    const allTasks = await get(taskSignals$);
    signal.throwIfAborted();
    const currentIndex = allTasks.findIndex((ts) => {
      return ts.taskId === taskId;
    });
    if (currentIndex === -1) {
      return;
    }

    const ts = allTasks[currentIndex];
    const runId = get(ts.task$).latestRunId;
    if (!runId) {
      return;
    }

    // Close panel if open
    if (get(ts.open$)) {
      set(ts.closeTask$);
    }

    // Determine next card to focus (prefer next, fall back to previous)
    let nextTask: TaskSignals | undefined;
    if (currentIndex < allTasks.length - 1) {
      nextTask = allTasks[currentIndex + 1];
    } else if (currentIndex > 0) {
      nextTask = allTasks[currentIndex - 1];
    }

    // Optimistic archive — card disappears immediately from the UI
    const archived = new Set(get(internalArchivedRunIds$));
    archived.add(runId);
    set(internalArchivedRunIds$, archived);

    // Focus next card after optimistic removal
    if (nextTask) {
      set(nextTask.focusCard$);
    }

    // Persist the archive to the server
    await set(archiveTask$, taskId, signal);
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
      return ts.taskId === maximizedId;
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

// ---------------------------------------------------------------------------
// Unread commands
// ---------------------------------------------------------------------------

/**
 * Whether any task in the list is unread.
 */
export const hasUnreadTasks$ = computed(async (get) => {
  const tasks = await get(taskSignals$);
  return tasks.some((ts) => {
    return get(ts.unread$);
  });
});

/**
 * Mark all current tasks as read.
 */
export const markAllTasksRead$ = command(({ get, set }) => {
  const taskSignals = get(internalTaskSignals$);
  const current = get(lastSeenRunIds$);
  const updated = { ...current };
  let changed = false;

  for (const [id, ts] of taskSignals) {
    const task = get(ts.task$);
    if (task.latestRunId && updated[id] !== task.latestRunId) {
      updated[id] = task.latestRunId;
      changed = true;
    }
  }

  if (changed) {
    set(lastSeenRunIdsStorage.set$, JSON.stringify(updated));
  }
});
