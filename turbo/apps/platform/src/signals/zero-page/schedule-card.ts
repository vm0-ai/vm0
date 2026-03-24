import { command, computed, state, type StateArg } from "ccstate";
import type { ScheduleEntry } from "../../views/zero-page/zero-schedule-card.tsx";

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

export const { get$: addScheduleOpen$, set$: setAddScheduleOpen$ } =
  cell(false);

export const { get$: editingScheduleId$, set$: setEditingScheduleId$ } = cell<
  string | null
>(null);

export const { get$: saveError$, set$: setSaveError$ } = cell<string | null>(
  null,
);

export const { get$: togglingIds$, set$: setTogglingIds$ } = cell<Set<string>>(
  new Set(),
);

export const {
  get$: calendarPopoverEntryId$,
  set$: setCalendarPopoverEntryId$,
} = cell<string | null>(null);
