import { command, computed, state } from "ccstate";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
  type SkillFileEntry,
  type ZeroAgentCustomSkill,
  type ZeroAgentSkillContentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { toast } from "@vm0/ui/components/ui/sonner";

import { accept } from "../../lib/accept.ts";
import { agents$ } from "../agent.ts";
import { zeroClient$ } from "../api-client.ts";

const SKILL_FILE_PATH = "SKILL.md";

const internalReloadSkills$ = state(0);
const internalSelectedSkillName$ = state<string | null>(null);
const internalSkillSearch$ = state("");
const internalSelectedAgentId$ = state<string | null>(null);
const internalSkillDraft$ = state("");
const internalSkillDraftName$ = state<string | null>(null);

export const skillSearch$ = computed((get) => {
  return get(internalSkillSearch$);
});

export const selectedSkillAgentId$ = computed((get) => {
  return get(internalSelectedAgentId$);
});

export const setSkillSearch$ = command(({ set }, value: string) => {
  set(internalSkillSearch$, value);
});

export const setSelectedSkillAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(internalSelectedAgentId$, agentId);
  },
);

export const setSelectedSkillName$ = command(({ set }, skillName: string) => {
  set(internalSelectedSkillName$, skillName);
});

const reloadOrgSkills$ = command(({ set }) => {
  set(internalReloadSkills$, (value) => {
    return value + 1;
  });
});

const orgSkills$ = computed(
  async (get): Promise<readonly ZeroAgentCustomSkill[]> => {
    get(internalReloadSkills$);
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

export const selectedSkillName$ = computed(async (get) => {
  const filteredSkills = await get(filteredOrgSkills$);
  const selectedName = get(internalSelectedSkillName$);
  if (
    selectedName &&
    filteredSkills.some((skill) => {
      return skill.name === selectedName;
    })
  ) {
    return selectedName;
  }

  return filteredSkills[0]?.name ?? null;
});

export const selectedSkillDetail$ = computed(
  async (get): Promise<ZeroAgentSkillContentResponse | null> => {
    get(internalReloadSkills$);
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

export const selectedSkillDraft$ = computed(async (get) => {
  const detail = await get(selectedSkillDetail$);
  if (!detail) {
    return "";
  }

  const draftName = get(internalSkillDraftName$);
  if (draftName === detail.name) {
    return get(internalSkillDraft$);
  }

  return detail.content ?? "";
});

export const selectedSkillDirty$ = computed(async (get) => {
  const detail = await get(selectedSkillDetail$);
  if (!detail) {
    return false;
  }

  const draft = await get(selectedSkillDraft$);
  return draft !== (detail.content ?? "");
});

export const setSelectedSkillDraft$ = command(
  ({ set }, skillName: string, value: string) => {
    set(internalSkillDraftName$, skillName);
    set(internalSkillDraft$, value);
  },
);

function replaceSkillFileContent(
  files: readonly SkillFileEntry[],
  content: string,
): readonly SkillFileEntry[] {
  let found = false;
  const nextFiles = files.map((file) => {
    if (file.path !== SKILL_FILE_PATH) {
      return file;
    }
    found = true;
    return { path: file.path, content };
  });

  if (found) {
    return nextFiles;
  }

  return [{ path: SKILL_FILE_PATH, content }, ...nextFiles];
}

export const saveSelectedSkillContent$ = command(
  async ({ get, set }, content: string, signal: AbortSignal) => {
    const detail = await get(selectedSkillDetail$);
    signal.throwIfAborted();
    if (!detail) {
      return null;
    }

    const existingFiles =
      detail.fileContents ??
      (detail.content === null
        ? []
        : [{ path: SKILL_FILE_PATH, content: detail.content }]);
    const files = [...replaceSkillFileContent(existingFiles, content)];
    const client = get(zeroClient$)(zeroSkillsDetailContract);
    const result = await accept(
      client.update({
        params: { name: detail.name },
        body: { files },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(reloadOrgSkills$);
    set(internalSkillDraftName$, detail.name);
    set(internalSkillDraft$, content);
    toast.success("Skill updated");
    return result.body;
  },
);
