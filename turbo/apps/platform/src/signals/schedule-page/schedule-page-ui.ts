import { command, computed, state, type StateArg } from "ccstate";
import type { CombinedEntry } from "../../views/zero-page/zero-schedule-page.tsx";

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
// Schedule page UI state
// ---------------------------------------------------------------------------

export const { get$: createDialogOpen$, set$: setCreateDialogOpen$ } =
  cell(false);

export const { get$: creatingOrgSchedule$, set$: setCreatingOrgSchedule$ } =
  cell(false);

export const { get$: pageTogglingIds$, set$: setPageTogglingIds$ } = cell<
  Set<string>
>(new Set());

export const { get$: pageRunningIds$, set$: setPageRunningIds$ } = cell<
  Set<string>
>(new Set());

export const { get$: pagePendingDelete$, set$: setPagePendingDelete$ } =
  cell<CombinedEntry | null>(null);

// ---------------------------------------------------------------------------
// Calendar view state
// ---------------------------------------------------------------------------

const todayDayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;

export const { get$: calendarSelectedDay$, set$: setCalendarSelectedDay$ } =
  cell(todayDayIndex);

// ---------------------------------------------------------------------------
// Calendar entry popover open state
// ---------------------------------------------------------------------------

export const {
  get$: calendarPopoverEntryId$,
  set$: setCalendarPopoverEntryId$,
} = cell<string | null>(null);
