import { command, computed, state, type StateArg } from "ccstate";
import { nowDate } from "../../lib/time.ts";

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
// Calendar view state
// ---------------------------------------------------------------------------

function todayDayIndex(): number {
  const day = nowDate().getDay();
  return day === 0 ? 6 : day - 1;
}

const internalCalendarSelectedDay$ = state<number | null>(null);
export const calendarSelectedDay$ = computed((get) => {
  return get(internalCalendarSelectedDay$) ?? todayDayIndex();
});
export const setCalendarSelectedDay$ = command(({ set }, value: number) => {
  set(internalCalendarSelectedDay$, value);
});

// ---------------------------------------------------------------------------
// Calendar entry popover open state
// ---------------------------------------------------------------------------

export const {
  get$: calendarPopoverEntryId$,
  set$: setCalendarPopoverEntryId$,
} = cell<string | null>(null);
