/**
 * Fundamental agent signals used across the platform.
 *
 * This file is the single source of truth for agent identity, lists,
 * metadata, and avatar signals. Downstream code should import from here
 * instead of reaching into individual signal files.
 */
import { command, computed, type Computed, state } from "ccstate";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { teamContract } from "@okouai/api-contracts/contracts/team";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { onboardingStatus$ } from "./okou-page/onboarding.ts";
import { apiClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { localStorageSignals } from "./external/local-storage.ts";
import { retryTransientLoad } from "./utils.ts";
import { rootSignal$ } from "./root-signal.ts";
import { assistantName$ } from "./branding.ts";

const LAST_USED_AGENT_STORAGE_KEY = "zero.lastUsedAgentId";

const { get$: lastUsedAgentIdRaw$, set$: setLastUsedAgentIdRaw$ } =
  localStorageSignals(LAST_USED_AGENT_STORAGE_KEY);

export const defaultAgentId$ = computed(async (get) => {
  const status = await get(onboardingStatus$);
  return status.defaultAgentId;
});

const internalAgentByIdReload$ = state(0);

export function agentById(id: string): Computed<Promise<AgentResponse>> {
  return computed(async (get) => {
    get(internalAgentByIdReload$);
    const client = get(apiClient$)(agentsByIdContract);
    const result = await retryTransientLoad((signal) => {
      return accept(
        client.get({ params: { id }, fetchOptions: { signal } }),
        [200],
      );
    }, get(rootSignal$));
    return result.body;
  });
}

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
  return defaultAgent?.displayName ?? get(assistantName$);
});

export const currentAgentId$ = computed((get) => {
  const route = get(activeRoute$);
  if (
    route !== "agentDetail" &&
    route !== "agentChat" &&
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

const lastUsedAgentId$ = computed((get) => {
  const value = get(lastUsedAgentIdRaw$);
  if (typeof value !== "string") {
    return null;
  }

  const parsed = agentsByIdContract.get.pathParams.safeParse({ id: value });
  return parsed.success ? parsed.data.id : null;
});

export const rememberLastUsedAgentId$ = command(({ set }, agentId: string) => {
  set(setLastUsedAgentIdRaw$, agentId);
});

const internalReloadAgents$ = state(0);

/** All agents in the user's org (from /api/team). */
export const agents$ = computed(async (get) => {
  get(internalReloadAgents$);
  const apiClient = get(apiClient$)(teamContract);
  const result = await accept(apiClient.list(), [200]);
  return result.body;
});

export const homeAgentId$ = computed(async (get) => {
  const lastUsedAgentId = get(lastUsedAgentId$);
  if (lastUsedAgentId) {
    return lastUsedAgentId;
  }

  // Onboarding status already identifies the default agent. Resolve it
  // directly so the home route can hand off without waiting for /api/team.
  return await get(defaultAgentId$);
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
