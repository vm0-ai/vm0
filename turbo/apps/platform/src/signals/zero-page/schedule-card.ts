import { command, computed, state, type StateArg } from "ccstate";
import type { ScheduleEntry } from "../../views/zero-page/zero-schedule-card.tsx";
import { detach, Reason } from "../utils.ts";
import { fetchSlackChannels$ } from "./slack-channels.ts";

// ---------------------------------------------------------------------------
// Helper: creates a private state atom with exported computed (read) and
// command (write) pair, satisfying the no-export-state rule.
// ---------------------------------------------------------------------------

function cell<T>(initial: T) {
  const internal$ = state(initial);
  return Object.freeze({
    get$: computed((get) => get(internal$)),
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
export const addScheduleOpen$ = computed((get) => get(addScheduleOpenState$));
export const setAddScheduleOpen$ = command(({ set }, open: boolean) => {
  set(addScheduleOpenState$, open);
  if (open) {
    detach(set(fetchSlackChannels$), Reason.Deferred);
  }
});

const editingScheduleIdState$ = state<string | null>(null);
export const editingScheduleId$ = computed((get) =>
  get(editingScheduleIdState$),
);
export const setEditingScheduleId$ = command(({ set }, id: string | null) => {
  set(editingScheduleIdState$, id);
  if (id !== null) {
    detach(set(fetchSlackChannels$), Reason.Deferred);
  }
});

export const { get$: saveError$, set$: setSaveError$ } = cell<string | null>(
  null,
);

export const { get$: togglingIds$, set$: setTogglingIds$ } = cell<Set<string>>(
  new Set(),
);
