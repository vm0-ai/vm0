import { command, computed, state } from "ccstate";
import { zeroUserPreferencesContract } from "@vm0/core";
import { zeroTalkAgentId$ } from "./zero-nav.ts";
import { zeroClient$ } from "../api-client.ts";
import { clerk$ } from "../auth.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("ZeroModelPreference");

// ---------------------------------------------------------------------------
// Server-backed model preferences
// ---------------------------------------------------------------------------

const reloadModelPreferences$ = state(0);

/**
 * Optimistic override — when set, takes precedence over server value.
 */
const optimisticModelPreferences$ = state<Record<string, string> | null>(null);

/**
 * Model preferences fetched from user preferences API.
 */
const serverModelPreferences$ = computed(async (get) => {
  get(reloadModelPreferences$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUserPreferencesContract);
  const result = await client.get();
  if (result.status === 200) {
    return result.body.modelPreferences;
  }
  throw new Error(`Failed to fetch user preferences: ${result.status}`);
});

/**
 * Effective model preferences — optimistic value if set, otherwise server value.
 */
const modelPreferences$ = computed((get) => {
  const optimistic = get(optimisticModelPreferences$);
  if (optimistic !== null) {
    return optimistic;
  }
  return get(serverModelPreferences$);
});

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
 * Sync model preference from server for the current agent.
 * Called from each route's setup function on navigation.
 */
export const syncModelPreference$ = command(async ({ get, set }) => {
  const agentId = get(zeroTalkAgentId$);
  const key = agentId ?? "default";
  try {
    const prefs = await get(modelPreferences$);
    const value = prefs[key] ?? "default";
    set(internalSelectedModel$, value);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to sync model preference:", error);
    set(internalSelectedModel$, "default");
  }
});

/**
 * Persist the current model selection to the server.
 * Called before sending a message.
 */
export const persistModelPreference$ = command(async ({ get, set }) => {
  const agentId = get(zeroTalkAgentId$);
  const key = agentId ?? "default";
  const value = get(internalSelectedModel$);

  try {
    // Read current preferences
    const currentPrefs = await get(modelPreferences$);

    // Build updated preferences
    const updated = { ...currentPrefs };
    if (value === "default") {
      delete updated[key];
    } else {
      updated[key] = value;
    }

    // Optimistic update
    set(optimisticModelPreferences$, updated);

    // Persist to server
    const createClient = get(zeroClient$);
    const client = createClient(zeroUserPreferencesContract);
    const result = await client.update({ body: { modelPreferences: updated } });

    if (result.status !== 200) {
      L.error("Failed to persist model preference:", result.status);
      return;
    }

    // Force JWT refresh so updated membership metadata is available immediately
    const clerk = await get(clerk$);
    await clerk.session?.getToken({ skipCache: true });

    set(reloadModelPreferences$, (x) => x + 1);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to persist model preference:", error);
  } finally {
    set(optimisticModelPreferences$, null);
  }
});
