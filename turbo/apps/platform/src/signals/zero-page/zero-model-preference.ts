import { command } from "ccstate";
import { currentDraft$ } from "./chat-draft.ts";
import { currentAgentId$ } from "./agent.ts";
import {
  readLocalStorage,
  writeLocalStorage$,
} from "../external/local-storage.ts";

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
    const stored = readLocalStorage(key);
    set(draft.setSelectedModel$, stored ?? "default");
  }
});

/**
 * Persist the current model selection to localStorage.
 * Called before sending a message.
 */
export const persistModelPreference$ = command(({ get, set }) => {
  const agentId = get(currentAgentId$);
  const key = modelStorageKey(agentId);
  const draft = get(currentDraft$);
  if (draft) {
    const value = get(draft.selectedModel$);
    set(writeLocalStorage$, {
      key,
      value: value === "default" ? null : value,
    });
  }
});
