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

export interface SubagentInfo {
  id: string;
  displayName?: string | null;
}

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
