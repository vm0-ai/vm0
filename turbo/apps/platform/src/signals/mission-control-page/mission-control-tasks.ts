import { command, computed, state } from "ccstate";
import type { TaskItem } from "@vm0/core";
import {
  createChatThreadSignals,
  ensureDraft$,
  type ChatThreadSignals,
} from "../chat-page/create-chat-thread.ts";
import {
  createActivitySignals,
  type ActivitySignals,
} from "./create-activity-signals.ts";

// ---------------------------------------------------------------------------
// TaskPanelEntry — discriminated union for open panels
// ---------------------------------------------------------------------------

export type TaskPanelEntry =
  | { kind: "chat"; task: TaskItem; signals: ChatThreadSignals }
  | { kind: "activity"; task: TaskItem; signals: ActivitySignals };

// ---------------------------------------------------------------------------
// Open task registry — keyed by task.id
// ---------------------------------------------------------------------------

const openTasksMap$ = state(new Map<string, TaskPanelEntry>());

/**
 * Whether the Mission Control task panel is visible.
 * True when at least one task is open.
 */
export const missionControlPanelVisible$ = computed((get) => {
  return get(openTasksMap$).size > 0;
});

/**
 * Ordered list of [taskId, TaskPanelEntry] entries for rendering.
 */
export const openTaskEntries$ = computed((get): [string, TaskPanelEntry][] => {
  return [...get(openTasksMap$).entries()];
});

/**
 * Open a task in the Mission Control panel.
 * Chat tasks open as interactive conversations.
 * Other tasks with a latestRunId open as activity detail views.
 * If the task is already open, this is a no-op.
 */
export const openMissionControlTask$ = command(
  async ({ get, set }, task: TaskItem, signal: AbortSignal): Promise<void> => {
    const map = get(openTasksMap$);
    if (map.has(task.id)) {
      return;
    }

    if (task.type === "chat" && task.chatThreadId) {
      const draft = set(ensureDraft$, task.chatThreadId);
      const signals = createChatThreadSignals(task.chatThreadId, draft);
      set(
        openTasksMap$,
        new Map(map).set(task.id, { kind: "chat", task, signals }),
      );
      await set(signals.loadMessages$, signal);
      return;
    }

    if (task.latestRunId) {
      const signals = createActivitySignals(task.latestRunId);
      set(
        openTasksMap$,
        new Map(map).set(task.id, { kind: "activity", task, signals }),
      );
      await set(signals.startPolling$, signal);
    }
  },
);

/**
 * Close a task in the Mission Control panel.
 */
export const closeMissionControlTask$ = command(
  ({ get, set }, taskId: string) => {
    const map = get(openTasksMap$);
    if (!map.has(taskId)) {
      return;
    }
    const next = new Map(map);
    next.delete(taskId);
    set(openTasksMap$, next);
  },
);
