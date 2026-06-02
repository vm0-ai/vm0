import { command, computed, state } from "ccstate";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
  type ZeroAgentCustomSkill,
  type ZeroAgentSkillDetailResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";

import { accept } from "../../lib/accept.ts";
import { agents$ } from "../agent.ts";
import { zeroClient$ } from "../api-client.ts";

const internalSelectedSkillName$ = state<string | null>(null);
const internalSelectedSkillFilePath$ = state<string | null>(null);
const internalSkillSearch$ = state("");
const internalSelectedAgentId$ = state<string | null>(null);

export const skillSearch$ = computed((get) => {
  return get(internalSkillSearch$);
});

export const selectedSkillAgentId$ = computed((get) => {
  return get(internalSelectedAgentId$);
});

export const selectedSkillFilePath$ = computed((get) => {
  return get(internalSelectedSkillFilePath$);
});

export const setSkillSearch$ = command(({ set }, value: string) => {
  set(internalSkillSearch$, value);
});

export const setSelectedSkillAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(internalSelectedAgentId$, agentId);
  },
);

export const setSelectedSkillName$ = command(
  ({ set }, skillName: string | null) => {
    set(internalSelectedSkillName$, skillName);
    set(internalSelectedSkillFilePath$, null);
  },
);

export const setSelectedSkillFilePath$ = command(
  ({ set }, filePath: string | null) => {
    set(internalSelectedSkillFilePath$, filePath);
  },
);

export const selectedSkillName$ = computed((get) => {
  return get(internalSelectedSkillName$);
});

const orgSkills$ = computed(
  async (get): Promise<readonly ZeroAgentCustomSkill[]> => {
    const client = get(zeroClient$)(zeroSkillsCollectionContract);
    const result = await accept(client.list(), [200], { toast: false });
    return result.body;
  },
);

export const skillUsages$ = computed(
  async (get): Promise<ReadonlyMap<string, readonly TeamComposeItem[]>> => {
    const agents = await get(agents$);
    const usages = new Map<string, TeamComposeItem[]>();

    for (const agent of agents) {
      for (const skillName of agent.customSkills ?? []) {
        const current = usages.get(skillName) ?? [];
        current.push(agent);
        usages.set(skillName, current);
      }
    }

    return usages;
  },
);

export const filteredOrgSkills$ = computed(
  async (get): Promise<readonly ZeroAgentCustomSkill[]> => {
    const skills = await get(orgSkills$);
    const agents = await get(agents$);
    const search = get(internalSkillSearch$).trim().toLowerCase();
    const selectedAgentId = get(internalSelectedAgentId$);
    const selectedAgent = selectedAgentId
      ? agents.find((agent) => {
          return agent.id === selectedAgentId;
        })
      : null;
    const selectedAgentSkills = selectedAgent
      ? new Set(selectedAgent.customSkills ?? [])
      : null;

    return skills.filter((skill) => {
      if (selectedAgentSkills && !selectedAgentSkills.has(skill.name)) {
        return false;
      }

      if (!search) {
        return true;
      }

      const haystack = [
        skill.name,
        skill.displayName ?? "",
        skill.description ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
  },
);

export const selectedSkillDetail$ = computed(
  async (get): Promise<ZeroAgentSkillDetailResponse | null> => {
    const skillName = await get(selectedSkillName$);
    if (!skillName) {
      return null;
    }

    const client = get(zeroClient$)(zeroSkillsDetailContract);
    const result = await accept(
      client.get({ params: { name: skillName } }),
      [200],
      { toast: false },
    );
    return result.body;
  },
);
