import { command, computed, state } from "ccstate";
import type { SendMode } from "@vm0/core";

// ---------------------------------------------------------------------------
// Preferences tab state
// ---------------------------------------------------------------------------

const internalPreferencesTab$ = state("appearance");

export const preferencesTab$ = computed((get) => get(internalPreferencesTab$));

export const setPreferencesTab$ = command(({ set }, value: string) => {
  set(internalPreferencesTab$, value);
});

// ---------------------------------------------------------------------------
// Send mode saving state
// ---------------------------------------------------------------------------

const internalSendModeSaving$ = state<SendMode | null>(null);

export const sendModeSaving$ = computed((get) => get(internalSendModeSaving$));

export const setSendModeSaving$ = command(({ set }, value: SendMode | null) => {
  set(internalSendModeSaving$, value);
});
