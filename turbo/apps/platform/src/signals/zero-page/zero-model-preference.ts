import { command } from "ccstate";
import { currentDraft$ } from "./chat-draft.ts";
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
// State — now delegated to per-draft signals in chat-draft.ts
// ---------------------------------------------------------------------------

// Re-export convenience signals so existing imports keep working
export {
  draftSelectedModel$ as selectedModel$,
  setDraftSelectedModel$ as setSelectedModel$,
} from "./chat-draft.ts";

/**
 * Sync model preference from localStorage for the current agent.
 * Called from each route's setup function on navigation — writes to the
 * current draft's model selection.
 */
export const syncModelPreference$ = command(({ get, set }) => {
  const agentId = get(currentAgentId$);
  const key = modelStorageKey(agentId);
  const draft = get(currentDraft$);
  if (draft) {
    set(draft.setSelectedModel$, readModelPreference(key));
  }
});

/**
 * Persist the current model selection to localStorage.
 * Called before sending a message.
 */
export const persistModelPreference$ = command(({ get }) => {
  const agentId = get(currentAgentId$);
  const key = modelStorageKey(agentId);
  const draft = get(currentDraft$);
  if (draft) {
    const value = get(draft.selectedModel$);
    writeModelPreference(key, value);
  }
});
