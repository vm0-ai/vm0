import { command, computed } from "ccstate";
import { onboardingStatus$ } from "./onboarding.ts";
import { defaultAgentId$, sortedAgents$, subagents$ } from "../agent.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { unreadAgentIds$ } from "../chat-page/chat-thread-indicators-from-worker.ts";
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
  const status = await get(onboardingStatus$);
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

/** Pinned agent IDs resolved to full agent objects, in render order. */
export const pinnedAgents$ = computed(async (get) => {
  const order = await get(pinnedAgentIds$);
  const list = await get(sortedAgents$);
  const agentById = new Map(
    list.map((a) => {
      return [a.agentId, a];
    }),
  );
  return order
    .map((id) => {
      return agentById.get(id);
    })
    .filter((a): a is NonNullable<typeof a> => {
      return a !== undefined;
    });
});

export const displayedPinnedAgents$ = computed(async (get) => {
  const pinnedAgents = await get(pinnedAgents$);
  const unreadAgentIds = await get(unreadAgentIds$);
  const pinnedAgentIds = new Set(
    pinnedAgents.map((agent) => {
      return agent.agentId;
    }),
  );
  const unreadOnlyAgents = (await get(subagents$)).filter((agent) => {
    return (
      unreadAgentIds.has(agent.agentId) && !pinnedAgentIds.has(agent.agentId)
    );
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
 * Move a pinned agent to the position of another pinned agent. The default
 * agent always leads the pinned list, so it is neither moved nor displaced.
 */
export const movePinnedAgent$ = command(
  async (
    { get, set },
    {
      agentId,
      targetAgentId,
    }: { readonly agentId: string; readonly targetAgentId: string },
    signal: AbortSignal,
  ) => {
    const defaultAgentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (agentId === defaultAgentId || targetAgentId === defaultAgentId) {
      return;
    }

    const ids = (await get(pinnedAgentIds$)).filter((id) => {
      return id !== defaultAgentId;
    });
    signal.throwIfAborted();
    const from = ids.indexOf(agentId);
    const to = ids.indexOf(targetAgentId);
    if (from === -1 || to === -1 || from === to) {
      return;
    }

    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, agentId);
    await set(updateUserPreference$, { pinnedAgentIds: next }, signal);
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
