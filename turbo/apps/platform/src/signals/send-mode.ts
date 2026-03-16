import { command, computed, state } from "ccstate";

export type SendMode = "enter" | "cmd-enter";

const STORAGE_KEY = "zero.sendMode";

function readSendMode(): SendMode {
  if (typeof window === "undefined") {
    return "enter";
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "cmd-enter" ? "cmd-enter" : "enter";
}

const internalSendMode$ = state<SendMode>(readSendMode());

/** Current send mode preference. */
export const sendMode$ = computed((get) => get(internalSendMode$));

/** Update send mode and persist to localStorage. */
export const setSendMode$ = command(({ set }, mode: SendMode) => {
  localStorage.setItem(STORAGE_KEY, mode);
  set(internalSendMode$, mode);
});
