import { command, computed, state } from "ccstate";
import { z } from "zod";
import { onboardingStatus$ } from "./onboarding.ts";
import { defaultAgentId$, sortedAgents$, subagents$ } from "../agent.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { unreadAgentIds$ } from "../chat-page/chat-thread-indicators-from-worker.ts";
import { clerk$, currentOrgInfo$, currentUserInfo$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { bestEffort, jsonParseOr } from "../utils.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "./settings/user-preferences.ts";

const PINNED_AGENT_PREVIEW_CACHE_VERSION = 1;
const MAX_CACHED_PINNED_AGENT_PREVIEWS = 100;
const pinnedAgentPreviewCacheSchema = z
  .object({
    version: z.literal(PINNED_AGENT_PREVIEW_CACHE_VERSION),
    userId: z.string().min(1),
    orgId: z.string().min(1),
    defaultAgentId: z.string().nullable(),
    agents: z
      .array(
        z
          .object({
            agentId: z.string().min(1),
            displayName: z.string().nullable(),
            avatarUrl: z.string().nullable(),
          })
          .strict(),
      )
      .max(MAX_CACHED_PINNED_AGENT_PREVIEWS),
  })
  .strict();

export interface PinnedAgentPreview {
  readonly agentId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

export interface PinnedAgentPreviewSnapshot {
  readonly defaultAgentId: string | null;
  readonly agents: readonly PinnedAgentPreview[];
}

const {
  get$: pinnedAgentPreviewCacheRaw$,
  set$: setPinnedAgentPreviewCacheRaw$,
} = localStorageSignals("vm0:pinned-agent-preview-cache:v1");
const pinnedAgentPreviewCacheSyncGeneration$ = state(0);

const parsedPinnedAgentPreviewCache$ = computed((get) => {
  const raw = get(pinnedAgentPreviewCacheRaw$);
  if (raw === null) {
    return null;
  }
  const parsed = pinnedAgentPreviewCacheSchema.safeParse(
    jsonParseOr<unknown>(raw, null),
  );
  return parsed.success ? parsed.data : null;
});

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

/** Order pinned agents according to the user's saved preference. */
export const pinnedAgentRenderOrder$ = pinnedAgentIds$;

/** Pinned agent IDs resolved to full agent objects, in render order. */
export const pinnedAgents$ = computed(async (get) => {
  const order = await get(pinnedAgentRenderOrder$);
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

/**
 * Last authoritative pinned-agent presentation for the active user and org.
 * This cache intentionally excludes unread state and unread-only agents.
 */
export const cachedPinnedAgentPreviewSnapshot$ = computed(async (get) => {
  const cached = get(parsedPinnedAgentPreviewCache$);
  if (cached === null) {
    return null;
  }
  const [user, organization] = await Promise.all([
    get(currentUserInfo$),
    get(currentOrgInfo$),
  ]);
  if (user?.id !== cached.userId || organization?.id !== cached.orgId) {
    return null;
  }
  return {
    defaultAgentId: cached.defaultAgentId,
    agents: cached.agents,
  } satisfies PinnedAgentPreviewSnapshot;
});

const persistPinnedAgentPreviewCache$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const generation = get(pinnedAgentPreviewCacheSyncGeneration$) + 1;
    set(pinnedAgentPreviewCacheSyncGeneration$, generation);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    if (!userId || !orgId) {
      return;
    }

    const [agents, defaultAgentId] = await Promise.all([
      get(pinnedAgents$),
      get(defaultAgentId$),
    ]);
    signal.throwIfAborted();
    if (
      get(pinnedAgentPreviewCacheSyncGeneration$) !== generation ||
      clerk.user?.id !== userId ||
      clerk.organization?.id !== orgId
    ) {
      return;
    }
    const serialized = JSON.stringify({
      version: PINNED_AGENT_PREVIEW_CACHE_VERSION,
      userId,
      orgId,
      defaultAgentId,
      agents: agents.slice(0, MAX_CACHED_PINNED_AGENT_PREVIEWS).map((agent) => {
        return {
          agentId: agent.agentId,
          displayName: agent.displayName ?? null,
          avatarUrl: agent.avatarUrl ?? null,
        };
      }),
    });
    if (get(pinnedAgentPreviewCacheRaw$) !== serialized) {
      set(setPinnedAgentPreviewCacheRaw$, serialized);
    }
  },
);

/** Refresh the local preview cache without making cache failures user-facing. */
export const syncPinnedAgentPreviewCache$ = command(
  async ({ set }, signal: AbortSignal) => {
    await bestEffort(set(persistPinnedAgentPreviewCache$, signal), signal);
  },
);

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
    signal.throwIfAborted();
    await set(syncPinnedAgentPreviewCache$, signal);
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
    signal.throwIfAborted();
    await set(syncPinnedAgentPreviewCache$, signal);
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
