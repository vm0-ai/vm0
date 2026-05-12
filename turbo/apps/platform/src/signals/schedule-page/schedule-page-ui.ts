import { command, computed, state, type StateArg } from "ccstate";
import type { CombinedEntry } from "../../views/zero-page/zero-schedule-page.tsx";
import { userPreferences$ } from "../zero-page/settings/user-preferences.ts";
import { agents$ } from "../agent.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { createDefaultFormData, initDialogForm$ } from "./schedule-form.ts";
import { toggleOrgScheduleEnabled$ } from "../zero-page/zero-schedule.ts";
import { withCleanup } from "../utils.ts";

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

const internalCreateDialogOpen$ = state(false);
export const createDialogOpen$ = computed((get) => {
  return get(internalCreateDialogOpen$);
});

export const openCreateScheduleDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const [prefs, allAgents, status] = await Promise.all([
      get(userPreferences$),
      get(agents$),
      get(zeroOnboardingStatus$),
    ]);
    signal.throwIfAborted();
    const agentId = status?.defaultAgentId ?? allAgents[0]?.id;
    if (!agentId) {
      return;
    }
    const defaults = createDefaultFormData();
    set(initDialogForm$, {
      ...defaults,
      timezone: prefs?.timezone ?? defaults.timezone,
      agentId,
      modelProviderId: null,
      selectedModel: null,
    });
    set(internalCreateDialogOpen$, true);
  },
);

export const closeCreateScheduleDialog$ = command(({ set }) => {
  set(internalCreateDialogOpen$, false);
});

export const { get$: creatingOrgSchedule$, set$: setCreatingOrgSchedule$ } =
  cell(false);

const internalPageTogglingIds$ = state<Set<string>>(new Set());
export const pageTogglingIds$ = computed((get) => {
  return get(internalPageTogglingIds$);
});

function addPendingId(id: string) {
  return (prev: Set<string>) => {
    return new Set([...prev, id]);
  };
}

function removePendingId(id: string) {
  return (prev: Set<string>) => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  };
}

export const togglePageScheduleEnabled$ = command(
  async (
    { set },
    params: { id: string; name: string; enabled: boolean; agentId: string },
    signal: AbortSignal,
  ) => {
    set(internalPageTogglingIds$, addPendingId(params.id));
    await withCleanup(
      set(
        toggleOrgScheduleEnabled$,
        {
          name: params.name,
          enabled: params.enabled,
          agentId: params.agentId,
        },
        signal,
      ),
      () => {
        set(internalPageTogglingIds$, removePendingId(params.id));
      },
    );
  },
);

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
