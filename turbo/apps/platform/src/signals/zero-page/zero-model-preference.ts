import { command, computed, state } from "ccstate";
import { currentAgentId$ } from "./agent.ts";

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

function modelStorageKey(agentId: string | null): string {
  return `zero.modelProvider.${agentId ?? "default"}`;
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
 * Called from each route's setup function on navigation — eliminates the
 * prevAgentId + queueMicrotask pattern entirely.
 */
export const syncModelPreference$ = command(({ get, set }) => {
  const agentId = get(currentAgentId$);
  const key = modelStorageKey(agentId);
  set(internalSelectedModel$, readModelPreference(key));
});

/**
 * Persist the current model selection to localStorage.
 * Called before sending a message.
 */
export const persistModelPreference$ = command(({ get }) => {
  const agentId = get(currentAgentId$);
  const key = modelStorageKey(agentId);
  const value = get(internalSelectedModel$);
  writeModelPreference(key, value);
});
