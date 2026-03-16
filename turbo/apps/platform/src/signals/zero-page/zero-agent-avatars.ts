import { command, computed } from "ccstate";
import { localStorageSignals } from "../external/local-storage.ts";
import { throwIfAbort } from "../utils.ts";

const STORAGE_KEY = "zero.agentAvatarOverrides";
const { get$: stored$, set$: persist$ } = localStorageSignals(STORAGE_KEY);

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === "string");
}

/**
 * Agent avatar overrides stored as JSON: `{ [agentName]: avatarSrc }`.
 * Falls back to an empty object when nothing is stored.
 */
const overrides$ = computed((get): Record<string, string> => {
  const raw = get(stored$);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStringRecord(parsed) ? parsed : {};
  } catch (error) {
    throwIfAbort(error);
    return {};
  }
});

/**
 * All agent avatar overrides. Callers can read a specific agent's override
 * by indexing into the result with the agent name.
 */
export const agentAvatarOverrides$ = overrides$;

/**
 * Set the avatar for an agent, persisted in localStorage.
 */
export const setAgentAvatar$ = command(
  ({ get, set }, name: string, src: string) => {
    const current = get(overrides$);
    const next = { ...current, [name]: src };
    set(persist$, JSON.stringify(next));
  },
);
