import { command, computed, state } from "ccstate";
import { zeroTeamContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReloadAgents$ = state(0);
export const agents$ = computed(async (get) => {
  get(internalReloadAgents$);
  const teamClient = get(zeroClient$)(zeroTeamContract);
  const result = await accept(teamClient.list(), [200]);
  return result.body;
});

export const reloadAgents$ = command(({ set }) => {
  set(internalReloadAgents$, (prev) => {
    return prev + 1;
  });
});
