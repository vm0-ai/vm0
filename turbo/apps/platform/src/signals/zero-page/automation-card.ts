import { command, computed, state, type StateArg } from "ccstate";
import type { AutomationEntry } from "../../views/zero-page/zero-automation-card.tsx";
import { withCleanup } from "../utils.ts";
import { fetchSlackChannels$ } from "./slack-channels.ts";
import { userPreferences$ } from "./settings/user-preferences.ts";
import {
  createDefaultFormData,
  initDialogForm$,
  type AutomationFormData,
} from "../../signals/automation-page/automation-form.ts";

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
// Automation card component state
// ---------------------------------------------------------------------------

export const { get$: automationViewMode$, set$: setAutomationViewMode$ } = cell<
  "list" | "calendar"
>("list");

const addAutomationOpenState$ = state(false);
export const addAutomationOpen$ = computed((get) => {
  return get(addAutomationOpenState$);
});
export const setAddAutomationOpen$ = command(
  async ({ get, set }, open: boolean, signal: AbortSignal) => {
    set(addAutomationOpenState$, open);
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

const editingAutomationIdState$ = state<string | null>(null);
export const editingAutomationId$ = computed((get) => {
  return get(editingAutomationIdState$);
});

export const setEditingAutomationId$ = command(
  async ({ set }, id: string | null, signal: AbortSignal) => {
    set(editingAutomationIdState$, id);
    if (id !== null) {
      await set(fetchSlackChannels$, signal);
    }
  },
);

export const openEditAutomationDialog$ = command(
  async (
    { set },
    id: string,
    initialValues: AutomationFormData,
    signal: AbortSignal,
  ) => {
    set(editingAutomationIdState$, id);
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

export const toggleAutomationCardEnabled$ = command(
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
  cell<AutomationEntry | null>(null);

export const { get$: deletingAutomation$, set$: setDeletingAutomation$ } =
  cell(false);
