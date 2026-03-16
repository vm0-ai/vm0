import { command, computed } from "ccstate";
import { localStorageSignals } from "../external/local-storage.ts";

const STORAGE_KEY = "zero.agentAvatarOverrides";
const { get$: stored$, set$: persist$ } = localStorageSignals(STORAGE_KEY);

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
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
});

/**
 * Read the avatar override for a given agent.
 * Returns `null` when no override exists (caller should fall back to default).
 */
export const agentAvatarOverride$ = (name: string) =>
  computed((get): string | null => {
    return get(overrides$)[name] ?? null;
  });

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
