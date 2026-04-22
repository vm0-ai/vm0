/**
 * Fundamental agent signals used across the platform.
 *
 * This file is the single source of truth for agent identity, lists,
 * metadata, and avatar signals. Downstream code should import from here
 * instead of reaching into individual signal files.
 */
import { command, computed, type Computed, state } from "ccstate";
import {
  type ZeroAgentResponse,
  zeroAgentsByIdContract,
  zeroTeamContract,
} from "@vm0/core";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { zeroOnboardingStatus$ } from "./zero-page/zero-onboarding.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";

export const defaultAgentId$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentId;
});

const internalAgentByIdReload$ = state(0);

function createAgentByIdFactory(): (
  id: string,
) => Computed<Promise<ZeroAgentResponse>> {
  const cache = new Map<string, Computed<Promise<ZeroAgentResponse>>>();
  return (id: string) => {
    const existing = cache.get(id);
    if (existing) {
      return existing;
    }
    const atom$ = computed(async (get) => {
      get(internalAgentByIdReload$);
      const client = get(zeroClient$)(zeroAgentsByIdContract);
      const result = await accept(client.get({ params: { id } }), [200]);
      return result.body;
    });
    cache.set(id, atom$);
    return atom$;
  };
}

export const agentById = createAgentByIdFactory();

export const reloadAgentById$ = command(({ set }) => {
  set(internalAgentByIdReload$, (prev) => {
    return prev + 1;
  });
});

const defaultAgent$ = computed(async (get) => {
  const defaultId = await get(defaultAgentId$);
  if (!defaultId) {
    return null;
  }
  return get(agentById(defaultId));
});

export const defaultAgentName$ = computed(async (get) => {
  const defaultAgent = await get(defaultAgent$);
  return defaultAgent?.displayName ?? "Zero";
});

export const currentAgentId$ = computed((get) => {
  const route = get(activeRoute$);
  if (
    route !== "agentDetail" &&
    route !== "agentChat" &&
    route !== "agentTalk" &&
    route !== "agentIdeas" &&
    route !== "agentPermissions"
  ) {
    return null;
  }

  const params = get(pathParams$);
  const agentId = params?.agentId;
  return typeof agentId === "string" ? agentId : null;
});

export const currentAgent$ = computed((get) => {
  const agentId = get(currentAgentId$);
  if (!agentId) {
    return null;
  }
  return get(agentById(agentId));
});

const internalReloadAgents$ = state(0);

/** All agents in the user's org (from /api/zero/team). */
export const agents$ = computed(async (get) => {
  get(internalReloadAgents$);
  const zeroClient = get(zeroClient$)(zeroTeamContract);
  const result = await accept(zeroClient.list(), [200]);
  return result.body;
});

export const sortedAgents$ = computed(async (get) => {
  const agents = await get(agents$);
  const defaultId = await get(defaultAgentId$);
  return [
    ...agents.filter((a) => {
      return a.id === defaultId;
    }),
    ...agents.filter((a) => {
      return a.id !== defaultId;
    }),
  ];
});

/** Bump to refetch the agents list. */
export const reloadAgents$ = command(({ set }) => {
  set(internalReloadAgents$, (prev) => {
    return prev + 1;
  });
});

/** Non-default agents. */
export const subagents$ = computed(async (get) => {
  const all = await get(agents$);
  const defaultId = await get(defaultAgentId$);
  return all.filter((a) => {
    return a.id !== defaultId;
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface SubagentInfo {
  id: string;
  displayName?: string | null;
}

export const leadAgentAvatarUrl$ = computed(async (get) => {
  const agent = await get(defaultAgent$);
  return agent?.avatarUrl ?? null;
});
