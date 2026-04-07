import { command, computed, state, type StateArg } from "ccstate";
import type { ScheduleEntry } from "../../views/zero-page/zero-schedule-card.tsx";
import { fetchSlackChannels$ } from "./slack-channels.ts";

// ---------------------------------------------------------------------------
// Helper: creates a private state atom with exported computed (read) and
// command (write) pair, satisfying the no-export-state rule.
// ---------------------------------------------------------------------------

function cell<T>(initial: T) {
  const internal$ = state(initial);
  return Object.freeze({
    get$: computed((get) => {
      return get(internal$);
    }),
    set$: command(({ set }, value: StateArg<T>) => {
      set(internal$, value);
    }),
  });
}

// ---------------------------------------------------------------------------
// Schedule card component state
// ---------------------------------------------------------------------------

export const { get$: scheduleViewMode$, set$: setScheduleViewMode$ } = cell<
  "list" | "calendar"
>("list");

export const { get$: internalScheduleList$, set$: setScheduleList$ } = cell<
  ScheduleEntry[]
>([]);

const addScheduleOpenState$ = state(false);
export const addScheduleOpen$ = computed((get) => {
  return get(addScheduleOpenState$);
});
export const setAddScheduleOpen$ = command(
  async ({ set }, open: boolean, signal: AbortSignal) => {
    set(addScheduleOpenState$, open);
    if (open) {
      await set(fetchSlackChannels$, signal);
    }
  },
);

const editingScheduleIdState$ = state<string | null>(null);
export const editingScheduleId$ = computed((get) => {
  return get(editingScheduleIdState$);
});

export const setEditingScheduleId$ = command(
  async ({ set }, id: string | null, signal: AbortSignal) => {
    set(editingScheduleIdState$, id);
    if (id !== null) {
      await set(fetchSlackChannels$, signal);
    }
  },
);

export const { get$: togglingIds$, set$: setTogglingIds$ } = cell<Set<string>>(
  new Set(),
);

export const { get$: runningIds$, set$: setRunningIds$ } = cell<Set<string>>(
  new Set(),
);

export const { get$: pendingDeleteEntry$, set$: setPendingDeleteEntry$ } =
  cell<ScheduleEntry | null>(null);

export const { get$: deletingSchedule$, set$: setDeletingSchedule$ } =
  cell(false);
