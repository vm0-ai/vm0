/**
 * Fundamental agent signals used across the platform.
 *
 * This file is the single source of truth for agent identity, lists,
 * metadata, and avatar signals. Downstream code should import from here
 * instead of reaching into individual signal files.
 */
import { command, computed, state } from "ccstate";
import { zeroAgentsByIdContract, zeroTeamContract } from "@vm0/core";
import { pathParams$ } from "./route.ts";
import { activeRoute$ } from "./active-route.ts";
import { zeroOnboardingStatus$ } from "./zero-page/zero-onboarding.ts";
import { zeroClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";
import { resolveAvatarUrl } from "../views/zero-page/avatar-utils.ts";
import avatar1Img from "../views/zero-page/assets/avatar_1.webp";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "./zero-page/zero-pinned-agents.ts";

export const defaultAgentId$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentId;
});

export const defaultAgentMetadata$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentMetadata ?? null;
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
  const id = params?.id;
  return typeof id === "string" ? id : null;
});

// ---------------------------------------------------------------------------
// Identity — sidebar agent (user-selected, falls back to default)
// ---------------------------------------------------------------------------

const internalSidebarAgentId$ = state<string | null>(null);

/** The agent currently selected in the sidebar. Falls back to the default agent. */
export const sidebarAgentId$ = computed(async (get): Promise<string | null> => {
  return get(internalSidebarAgentId$) ?? (await get(defaultAgentId$));
});

export const setSidebarAgent$ = command(({ set }, agentId: string | null) => {
  set(internalSidebarAgentId$, agentId);
});

// ---------------------------------------------------------------------------
// Agent lists
// ---------------------------------------------------------------------------

const internalReloadAgents$ = state(0);

/** All agents in the user's org (from /api/zero/team). */
export const agents$ = computed(async (get) => {
  get(internalReloadAgents$);
  const teamClient = get(zeroClient$)(zeroTeamContract);
  const result = await accept(teamClient.list(), [200]);
  return result.body;
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

/** Display name of the default (lead) agent. */
export const agentDisplayName$ = computed(async (get) => {
  const metadata = await get(defaultAgentMetadata$);
  return metadata?.displayName || "Zero";
});

// ---------------------------------------------------------------------------
// SubagentInfo — lightweight shape for sidebar/pinned UI
// ---------------------------------------------------------------------------

export interface SubagentInfo {
  id: string;
  displayName?: string | null;
}

/** Re-export pinned agent primitives. */
export { pinnedAgentIds$, updatePinnedAgentIds$ };

/** Pinned agent IDs resolved to SubagentInfo. */
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

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

/** Avatar for the current sidebar agent. */
export const sidebarAgentAvatar$ = computed(async (get) => {
  const agentId = await get(sidebarAgentId$);
  if (!agentId) {
    return null;
  }
  const client = get(zeroClient$)(zeroAgentsByIdContract);
  const result = await accept(client.get({ params: { id: agentId } }), [200], {
    toast: false,
  });
  return resolveAvatarUrl(result.body.avatarUrl) ?? avatar1Img;
});

/** Avatar for the default (lead) agent — used in pinned-agent dialogs. */
export const leadAgentAvatar$ = computed(async (get) => {
  const agentId = await get(defaultAgentId$);
  if (!agentId) {
    return null;
  }
  const client = get(zeroClient$)(zeroAgentsByIdContract);
  const result = await accept(client.get({ params: { id: agentId } }), [200], {
    toast: false,
  });
  return resolveAvatarUrl(result.body.avatarUrl) ?? avatar1Img;
});
