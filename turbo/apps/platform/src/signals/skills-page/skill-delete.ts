import { command, computed, state } from "ccstate";
import { zeroSkillsDetailContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { reloadSkillsList$ } from "./skills-list.ts";

const internalPendingDelete$ = state<string | null>(null);

export const pendingDeleteName$ = computed((get) => {
  return get(internalPendingDelete$);
});

export const setPendingDeleteName$ = command(({ set }, name: string | null) => {
  set(internalPendingDelete$, name);
});

export const deleteSkill$ = command(
  async ({ get, set }, name: string, _signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroSkillsDetailContract);
    await accept(client.delete({ params: { name } }), [204]);
    set(reloadSkillsList$);
  },
);
