import { command, computed, state } from "ccstate";
import { zeroTeamContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";

const internalReloadAgents$ = state(0);
export const agents$ = computed(async (get) => {
  get(internalReloadAgents$);
  const teamClient = get(zeroClient$)(zeroTeamContract);
  const agentsResult = await teamClient.list();
  if (agentsResult.status !== 200) {
    throw new Error(`Failed to fetch agents (${agentsResult.status})`);
  }
  return agentsResult.body;
});

export const reloadAgents$ = command(({ set }) => {
  set(internalReloadAgents$, (prev) => prev + 1);
});
