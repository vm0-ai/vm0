import { command, computed } from "ccstate";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { defaultAgentId$, sortedAgents$, subagents$ } from "../agent.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { unreadAgentIds$ } from "../chat-page/sidebar-unread-threads.ts";
import {
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
  const pinnedIds = new Set(ids);
  const list = await get(sortedAgents$);
  return list.filter((a) => {
    return pinnedIds.has(a.id);
  });
});

export const displayedPinnedAgents$ = computed(async (get) => {
  const pinnedAgents = await get(pinnedAgents$);
  const unreadAgentIds = await get(unreadAgentIds$);
  const pinnedAgentIds = new Set(
    pinnedAgents.map((agent) => {
      return agent.id;
    }),
  );
  const unreadOnlyAgents = (await get(subagents$)).filter((agent) => {
    return unreadAgentIds.has(agent.id) && !pinnedAgentIds.has(agent.id);
  });
  return [...pinnedAgents, ...unreadOnlyAgents];
});

export const setAgentPinned$ = command(
  async (
    { get, set },
    { agentId, pinned }: { readonly agentId: string; readonly pinned: boolean },
    signal: AbortSignal,
  ) => {
    const defaultAgentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (agentId === defaultAgentId) {
      return;
    }

    const ids = await get(pinnedAgentIds$);
    signal.throwIfAborted();
    const next = new Set(
      ids.filter((id) => {
        return id !== defaultAgentId;
      }),
    );
    if (pinned) {
      next.add(agentId);
    } else {
      next.delete(agentId);
    }

    await set(updateUserPreference$, { pinnedAgentIds: [...next] }, signal);
  },
);

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
