import { command, computed, state } from "ccstate";
import { nowDate } from "../../lib/time.ts";

// ---------------------------------------------------------------------------
// Automation form data — single state object for all form fields
// ---------------------------------------------------------------------------

export interface AutomationFormData {
  freq: string;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  loopMinutes: number;
  agentId: string;
  description: string;
  dayOfWeek: string;
  dayOfMonth: string;
  prompt: string;
}

export function createDefaultFormData(): AutomationFormData {
  return {
    freq: "every_day",
    date: nowDate().toISOString().slice(0, 10),
    hour: 9,
    minute: 0,
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    loopMinutes: 15,
    agentId: "",
    description: "",
    dayOfWeek: "1",
    dayOfMonth: "1",
    prompt: "",
  };
}

const internalAutomationForm$ = state<AutomationFormData>(
  createDefaultFormData(),
);

export const automationForm$ = computed((get) => {
  return get(internalAutomationForm$);
});

export const updateAutomationForm$ = command(
  ({ set }, partial: Partial<AutomationFormData>) => {
    set(internalAutomationForm$, (prev) => {
      return { ...prev, ...partial };
    });
  },
);

// ---------------------------------------------------------------------------
// "Saved state" snapshot for dirty detection (detail page settings form)
// ---------------------------------------------------------------------------

export type AutomationSettingsSnapshot = Omit<AutomationFormData, "prompt">;

const internalSavedState$ = state<AutomationSettingsSnapshot | null>(null);

export const savedSettingsState$ = computed((get) => {
  return get(internalSavedState$);
});

export const setSavedSettingsState$ = command(
  ({ set }, snapshot: AutomationSettingsSnapshot) => {
    set(internalSavedState$, snapshot);
  },
);

// ---------------------------------------------------------------------------
// Show delete confirm toggle (detail page settings form)
// ---------------------------------------------------------------------------

const internalShowDeleteConfirm$ = state(false);

export const showDeleteConfirm$ = computed((get) => {
  return get(internalShowDeleteConfirm$);
});

export const setShowDeleteConfirm$ = command(({ set }, value: boolean) => {
  set(internalShowDeleteConfirm$, value);
});

// ---------------------------------------------------------------------------
// Instruction editor state (detail page)
// ---------------------------------------------------------------------------

const internalInstructionDraft$ = state<string | null>(null);

export const instructionDraft$ = computed((get) => {
  return get(internalInstructionDraft$);
});

export const setInstructionDraft$ = command(({ set }, draft: string | null) => {
  set(internalInstructionDraft$, draft);
});

const internalDiscardNonce$ = state(0);

export const discardNonce$ = computed((get) => {
  return get(internalDiscardNonce$);
});

export const incrementDiscardNonce$ = command(({ set }) => {
  set(internalDiscardNonce$, (n) => {
    return n + 1;
  });
});

// ---------------------------------------------------------------------------
// Dialog form — showConfirm toggle
// ---------------------------------------------------------------------------

const internalShowConfirm$ = state(false);

export const showConfirm$ = computed((get) => {
  return get(internalShowConfirm$);
});

export const setShowConfirm$ = command(({ set }, value: boolean) => {
  set(internalShowConfirm$, value);
});

// ---------------------------------------------------------------------------
// Dialog form state (separate from detail page form)
// ---------------------------------------------------------------------------

const internalDialogForm$ = state<AutomationFormData>(createDefaultFormData());

export const dialogForm$ = computed((get) => {
  return get(internalDialogForm$);
});

export const updateDialogForm$ = command(
  ({ set }, partial: Partial<AutomationFormData>) => {
    set(internalDialogForm$, (prev) => {
      return { ...prev, ...partial };
    });
  },
);

// ---------------------------------------------------------------------------
// Settings form initialization tracking (detail page)
// ---------------------------------------------------------------------------

const internalSettingsFormInitId$ = state<string | null>(null);

// ---------------------------------------------------------------------------
// Instruction editor initialization tracking (detail page)
// ---------------------------------------------------------------------------

const internalInstructionInitKey$ = state<string | null>(null);

// ---------------------------------------------------------------------------
// Dialog form initialization (called from useEffect when dialog opens)
// ---------------------------------------------------------------------------

export const initDialogForm$ = command(({ set }, data: AutomationFormData) => {
  set(internalDialogForm$, data);
  set(internalShowConfirm$, false);
});

// ---------------------------------------------------------------------------
// Settings form entry sync (detail page)
// ---------------------------------------------------------------------------

export const syncSettingsFormEntry$ = command(
  (
    { get, set },
    entryId: string,
    prompt: string,
    initial: AutomationSettingsSnapshot,
  ) => {
    if (get(internalSettingsFormInitId$) !== entryId) {
      set(internalSettingsFormInitId$, entryId);
      set(internalAutomationForm$, { ...initial, prompt });
      set(internalSavedState$, initial);
      set(internalShowDeleteConfirm$, false);
    }
  },
);

// ---------------------------------------------------------------------------
// Instruction draft entry sync (detail page)
// ---------------------------------------------------------------------------

export const syncInstructionDraftEntry$ = command(
  ({ get, set }, initKey: string) => {
    if (get(internalInstructionInitKey$) !== initKey) {
      set(internalInstructionInitKey$, initKey);
      set(internalInstructionDraft$, null);
    }
  },
);
