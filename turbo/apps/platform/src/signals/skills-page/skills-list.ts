import { command, computed, state } from "ccstate";
import {
  zeroSkillsCollectionContract,
  type ZeroAgentCustomSkill,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReload$ = state(0);

export const reloadSkillsList$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

export const skillsList$ = computed(
  async (get): Promise<ZeroAgentCustomSkill[]> => {
    get(internalReload$);
    const client = get(zeroClient$)(zeroSkillsCollectionContract);
    const result = await accept(client.list(), [200], { toast: false });
    return result.body;
  },
);
