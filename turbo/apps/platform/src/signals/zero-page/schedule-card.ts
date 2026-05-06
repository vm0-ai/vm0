import { command, computed, state, type StateArg } from "ccstate";
import type { ScheduleEntry } from "../../views/zero-page/zero-schedule-card.tsx";
import { withCleanup } from "../utils.ts";
import { fetchSlackChannels$ } from "./slack-channels.ts";
import { userPreferences$ } from "./settings/user-preferences.ts";
import {
  createDefaultFormData,
  initDialogForm$,
  type ScheduleFormData,
} from "../../signals/schedule-page/schedule-form.ts";

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
  async ({ get, set }, open: boolean, signal: AbortSignal) => {
    set(addScheduleOpenState$, open);
    if (open) {
      const prefs = await get(userPreferences$);
      signal.throwIfAborted();
      const defaults = createDefaultFormData();
      set(initDialogForm$, {
        ...defaults,
        timezone: prefs?.timezone ?? defaults.timezone,
      });
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

export const openEditScheduleDialog$ = command(
  async (
    { set },
    id: string,
    initialValues: ScheduleFormData,
    signal: AbortSignal,
  ) => {
    set(editingScheduleIdState$, id);
    set(initDialogForm$, initialValues);
    await set(fetchSlackChannels$, signal);
    signal.throwIfAborted();
  },
);

const internalTogglingIds$ = state<Set<string>>(new Set());
export const togglingIds$ = computed((get) => {
  return get(internalTogglingIds$);
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

export const toggleScheduleCardEnabled$ = command(
  async (
    { set },
    params: {
      id: string;
      name: string;
      enabled: boolean;
      onToggleEnabled: (params: {
        name: string;
        enabled: boolean;
      }) => Promise<void>;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    set(internalTogglingIds$, addPendingId(params.id));
    await withCleanup(
      params.onToggleEnabled({
        name: params.name,
        enabled: params.enabled,
      }),
      () => {
        set(internalTogglingIds$, removePendingId(params.id));
      },
    );
  },
);

export const { get$: runningIds$, set$: setRunningIds$ } = cell<Set<string>>(
  new Set(),
);

export const { get$: pendingDeleteEntry$, set$: setPendingDeleteEntry$ } =
  cell<ScheduleEntry | null>(null);

export const { get$: deletingSchedule$, set$: setDeletingSchedule$ } =
  cell(false);
