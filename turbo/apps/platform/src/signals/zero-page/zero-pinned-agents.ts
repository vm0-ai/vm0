import { command, computed } from "ccstate";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { agents$, defaultAgentId$ } from "../agent.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import {
  reloadUserPreferences$,
  updateUserPreference$,
  userPreferences$,
} from "./settings/user-preferences.ts";

/**
 * Pinned agent IDs fetched from user preferences API.
 */
const serverPinnedIds$ = computed(async (get) => {
  const preferences = await get(userPreferences$);
  return preferences.pinnedAgentIds;
});

/**
 * Effective pinned agent IDs — always reads from server.
 */
export const pinnedAgentIds$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  const defaultAgentId = status.defaultAgentId;
  return [
    defaultAgentId,
    ...(await get(serverPinnedIds$)).filter((id) => {
      return id !== defaultAgentId;
    }),
  ].filter((a): a is string => {
    return a !== null;
  });
});

/** Pinned agent IDs resolved to full agent objects. */
export const pinnedAgents$ = computed(async (get) => {
  const ids = await get(pinnedAgentIds$);
  const list = await get(agents$);
  return ids
    .map((id) => {
      return list.find((a) => {
        return a.id === id;
      });
    })
    .filter((a) => {
      return a !== undefined;
    });
});

/**
 * Whether the current chat agent is pinned. Returns null if no agent is selected.
 */
export const currentChatAgentPinned$ = computed(async (get) => {
  const agentId = await get(currentChatAgentId$);
  if (!agentId) {
    return null;
  }
  const ids = await get(pinnedAgentIds$);
  return ids.includes(agentId);
});

export const updatePinnedAgentIds$ = command(
  async ({ get, set }, ids: string[], signal: AbortSignal) => {
    const defaultAgentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    ids = ids.filter((id) => {
      return id !== defaultAgentId;
    });

    await set(updateUserPreference$, { pinnedAgentIds: ids }, signal);
  },
);

export const reloadPinnedAgents$ = command(({ set }) => {
  set(reloadUserPreferences$);
});
