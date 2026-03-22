import { command, computed, state } from "ccstate";
import { zeroChatAgentName$ } from "./zero-nav.ts";

function readModelPreference(key: string): string {
  if (typeof window === "undefined") {
    return "default";
  }
  return localStorage.getItem(key) ?? "default";
}

function writeModelPreference(key: string, value: string) {
  if (value === "default") {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
}

function modelStorageKey(agentName: string | null): string {
  return `zero.modelProvider.${agentName ?? "default"}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalSelectedModel$ = state("default");

/** Currently selected model provider for the active agent. */
export const selectedModel$ = computed((get) => get(internalSelectedModel$));

/** Set the selected model provider. */
export const setSelectedModel$ = command(({ set }, value: string) => {
  set(internalSelectedModel$, value);
});

/**
 * Sync model preference from localStorage for the current agent.
 * Called from setupZeroPage$ on each navigation — eliminates the
 * prevAgentName + queueMicrotask pattern entirely.
 */
export const syncModelPreference$ = command(({ get, set }) => {
  const agentName = get(zeroChatAgentName$);
  const key = modelStorageKey(agentName);
  set(internalSelectedModel$, readModelPreference(key));
});

/**
 * Persist the current model selection to localStorage.
 * Called before sending a message.
 */
export const persistModelPreference$ = command(({ get }) => {
  const agentName = get(zeroChatAgentName$);
  const key = modelStorageKey(agentName);
  const value = get(internalSelectedModel$);
  writeModelPreference(key, value);
});
