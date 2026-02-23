import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { stringify, parse } from "yaml";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { navigateInReact$ } from "../route.ts";
import { agentDetail$, fetchAgentDetail$ } from "./agent-detail.ts";
import { skillValueToUrl } from "../../data/skills.ts";
import { AGENT_NAME_REGEX, fetchSkillFrontmatter } from "@vm0/core";
import type { AgentDetail } from "./types.ts";

const L = logger("ConfigDialog");

// ---------------------------------------------------------------------------
// Dialog open/close state
// ---------------------------------------------------------------------------

const internalOpen$ = state(false);
export const configDialogOpen$ = computed((get) => get(internalOpen$));

// ---------------------------------------------------------------------------
// Editable compose — single source of truth for both tabs
// ---------------------------------------------------------------------------

type ComposeContent = NonNullable<AgentDetail["content"]>;

const internalEditableCompose$ = state<ComposeContent | null>(null);
export const editableCompose$ = computed((get) =>
  get(internalEditableCompose$),
);

// ---------------------------------------------------------------------------
// YAML text for the YAML tab — derived from editable compose
// ---------------------------------------------------------------------------

const internalYamlText$ = state("");
export const yamlText$ = computed((get) => get(internalYamlText$));

// ---------------------------------------------------------------------------
// YAML parse error (shown inline in YAML tab)
// ---------------------------------------------------------------------------

const internalYamlError$ = state<string | null>(null);
export const yamlError$ = computed((get) => get(internalYamlError$));

// ---------------------------------------------------------------------------
// Active tab
// ---------------------------------------------------------------------------

type ConfigTab = "yaml" | "forms";
const internalActiveTab$ = state<ConfigTab>("yaml");
export const configActiveTab$ = computed((get) => get(internalActiveTab$));

export const setConfigActiveTab$ = command(({ set }, tab: string) => {
  if (tab === "yaml" || tab === "forms") {
    set(internalActiveTab$, tab);
  }
});

// ---------------------------------------------------------------------------
// Saving state
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const configDialogSaving$ = computed((get) => get(internalSaving$));

// ---------------------------------------------------------------------------
// Save error
// ---------------------------------------------------------------------------

const internalSaveError$ = state<string | null>(null);
export const configDialogSaveError$ = computed((get) =>
  get(internalSaveError$),
);

// ---------------------------------------------------------------------------
// Validation — checks if the current compose state is valid for saving
// ---------------------------------------------------------------------------

export const configDialogValid$ = computed((get) => {
  const compose = get(internalEditableCompose$);
  if (!compose) {
    return true;
  }
  const agentKeys = Object.keys(compose.agents);
  const firstKey = agentKeys[0];
  if (firstKey === undefined || firstKey === "") {
    return false;
  }
  return AGENT_NAME_REGEX.test(firstKey);
});

// ---------------------------------------------------------------------------
// Skill env var sync — merge skill-declared env vars into compose on select
// ---------------------------------------------------------------------------

const internalOriginalSkillUrls$ = state<Set<string>>(new Set());
const internalSkillEnvHints$ = state<string[]>([]);
export const skillEnvHints$ = computed((get) => get(internalSkillEnvHints$));

interface SkillFrontmatterMap {
  url: string;
  secrets: string[];
  vars: string[];
}

async function fetchAllSkillFrontmatters(
  skills: string[],
): Promise<SkillFrontmatterMap[]> {
  if (skills.length === 0) {
    return [];
  }
  const results = await Promise.allSettled(
    skills.map((url) => fetchSkillFrontmatter(url)),
  );
  const out: SkillFrontmatterMap[] = [];
  for (let i = 0; i < skills.length; i++) {
    const result = results[i];
    if (result?.status !== "fulfilled" || !result.value) {
      continue;
    }
    out.push({
      url: skills[i]!,
      secrets: result.value.vm0_secrets ?? [],
      vars: result.value.vm0_vars ?? [],
    });
  }
  return out;
}

/**
 * Sync skill-declared env vars into the compose environment.
 * - Adds `${{ secrets.X }}` / `${{ vars.X }}` for newly declared vars.
 * - Removes stale skill-added entries (self-referencing pattern) when skills
 *   are deselected.
 * - Updates hints to show env vars from newly added skills only.
 */
const syncSkillEnvironment$ = command(
  async ({ get, set }, skills: string[]) => {
    const fms = await fetchAllSkillFrontmatters(skills);

    // Collect all declared env vars across current skills
    const declared = new Map<string, "secret" | "var">();
    for (const fm of fms) {
      for (const name of fm.secrets) {
        declared.set(name, "secret");
      }
      for (const name of fm.vars) {
        declared.set(name, "var");
      }
    }

    // Read latest compose and update environment
    const compose = get(internalEditableCompose$);
    if (!compose) {
      return;
    }
    const firstKey = Object.keys(compose.agents)[0];
    if (firstKey === undefined) {
      return;
    }
    const updated = structuredClone(compose);
    const agent = updated.agents[firstKey];
    if (!agent) {
      return;
    }

    const env: Record<string, string> = agent.environment ?? {};

    // Remove stale skill-added entries
    for (const key of Object.keys(env)) {
      const val = env[key];
      const isSkillAdded =
        val === `\${{ secrets.${key} }}` || val === `\${{ vars.${key} }}`;
      if (isSkillAdded && !declared.has(key)) {
        delete env[key];
      }
    }

    // Add missing entries
    for (const [name, source] of declared) {
      if (!(name in env)) {
        env[name] =
          source === "secret"
            ? `\${{ secrets.${name} }}`
            : `\${{ vars.${name} }}`;
      }
    }

    if (Object.keys(env).length > 0) {
      agent.environment = env;
    } else {
      delete agent.environment;
    }

    set(internalEditableCompose$, updated);
    set(internalYamlText$, stringify(updated));
    set(internalYamlError$, null);

    // Hints: only env vars from newly added skills
    const original = get(internalOriginalSkillUrls$);
    const hintNames = new Set<string>();
    for (const fm of fms) {
      if (original.has(fm.url)) {
        continue;
      }
      for (const name of [...fm.secrets, ...fm.vars]) {
        hintNames.add(name);
      }
    }
    set(internalSkillEnvHints$, [...hintNames]);
  },
);

// ---------------------------------------------------------------------------
// Open dialog — initialises editable state from current agent detail
// ---------------------------------------------------------------------------

export const openConfigDialog$ = command(({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail?.content) {
    return;
  }

  const content = detail.content;
  set(internalEditableCompose$, structuredClone(content));
  set(internalYamlText$, stringify(content));
  set(internalYamlError$, null);
  set(internalSaveError$, null);
  set(internalActiveTab$, "yaml");
  set(internalOpen$, true);

  // Track original skills so hints only show for newly added ones
  const agentKeys = Object.keys(content.agents);
  const firstKey = agentKeys[0];
  const originalSkills = firstKey
    ? (content.agents[firstKey]?.skills ?? [])
    : [];
  set(internalOriginalSkillUrls$, new Set(originalSkills));
  set(internalSkillEnvHints$, []);
});

// ---------------------------------------------------------------------------
// Close dialog
// ---------------------------------------------------------------------------

export const closeConfigDialog$ = command(({ set }) => {
  set(internalOpen$, false);
  set(internalSkillEnvHints$, []);
  set(internalOriginalSkillUrls$, new Set());
});

// ---------------------------------------------------------------------------
// Update from Forms tab — field-level updates to the compose
// ---------------------------------------------------------------------------

export const updateComposeField$ = command(
  ({ get, set }, field: string, value: string) => {
    const compose = get(internalEditableCompose$);
    if (!compose) {
      return;
    }

    const agentKeys = Object.keys(compose.agents);
    const firstKey = agentKeys[0];
    if (firstKey === undefined) {
      return;
    }

    const updated = structuredClone(compose);
    const agent = updated.agents[firstKey];
    if (!agent) {
      return;
    }

    switch (field) {
      case "description": {
        agent.description = value;
        break;
      }
      case "framework": {
        agent.framework = value;
        break;
      }
      case "instructions": {
        agent.instructions = value || undefined;
        break;
      }
    }

    set(internalEditableCompose$, updated);
    set(internalYamlText$, stringify(updated));
    set(internalYamlError$, null);
  },
);

// ---------------------------------------------------------------------------
// Update agent name — restructures the agents dictionary key
// ---------------------------------------------------------------------------

export const updateAgentName$ = command(({ get, set }, newName: string) => {
  const compose = get(internalEditableCompose$);
  if (!compose) {
    return;
  }

  const agentKeys = Object.keys(compose.agents);
  const firstKey = agentKeys[0];
  if (firstKey === undefined || newName === firstKey) {
    return;
  }

  const agentDef = compose.agents[firstKey];
  if (!agentDef) {
    return;
  }

  const updated: ComposeContent = {
    ...compose,
    agents: { [newName]: agentDef },
  };

  set(internalEditableCompose$, updated);
  set(internalYamlText$, stringify(updated));
  set(internalYamlError$, null);
});

// ---------------------------------------------------------------------------
// Update skills — converts values to GitHub URLs
// ---------------------------------------------------------------------------

export const updateSkills$ = command(({ get, set }, skillValues: string[]) => {
  const compose = get(internalEditableCompose$);
  if (!compose) {
    return;
  }

  const agentKeys = Object.keys(compose.agents);
  const firstKey = agentKeys[0];
  if (firstKey === undefined) {
    return;
  }

  const updated = structuredClone(compose);
  const agent = updated.agents[firstKey];
  if (!agent) {
    return;
  }

  agent.skills =
    skillValues.length > 0 ? skillValues.map(skillValueToUrl) : undefined;

  set(internalEditableCompose$, updated);
  set(internalYamlText$, stringify(updated));
  set(internalYamlError$, null);

  // Sync skill-declared env vars into compose environment
  set(syncSkillEnvironment$, agent.skills ?? []).catch(() => {});
});

// ---------------------------------------------------------------------------
// Update from YAML tab — parse YAML and update compose
// ---------------------------------------------------------------------------

export const updateYamlText$ = command(({ set }, text: string) => {
  set(internalYamlText$, text);

  try {
    const parsed = parse(text) as ComposeContent;

    // Basic validation: must have version and agents
    if (!parsed || typeof parsed !== "object" || !parsed.agents) {
      set(internalYamlError$, "Invalid YAML: must contain 'agents' field");
      return;
    }

    set(internalEditableCompose$, parsed);
    set(internalYamlError$, null);
  } catch (error) {
    throwIfAbort(error);
    set(
      internalYamlError$,
      error instanceof Error ? error.message : "Invalid YAML syntax",
    );
  }
});

// ---------------------------------------------------------------------------
// Save — POST to /api/agent/composes
// ---------------------------------------------------------------------------

export const saveConfigDialog$ = command(async ({ get, set }) => {
  const compose = get(internalEditableCompose$);
  const detail = get(agentDetail$);
  if (!compose || !detail) {
    return;
  }

  set(internalSaving$, true);
  set(internalSaveError$, null);

  try {
    const fetchFn = get(fetch$);
    const newAgentKey = Object.keys(compose.agents)[0];
    const nameChanged = newAgentKey && newAgentKey !== detail.name;
    const response = await fetchFn("/api/agent/composes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: compose,
        ...(nameChanged ? { previousName: detail.name } : {}),
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        errorData?.message ?? `Save failed: ${response.statusText}`,
      );
    }

    if (nameChanged) {
      // Navigate to new agent URL
      set(internalOpen$, false);
      toast.success("Agent configuration saved");
      set(navigateInReact$, "/agents/:name", {
        pathParams: { name: newAgentKey },
      });
    } else {
      // Refresh agent detail and close dialog
      await set(fetchAgentDetail$);
      set(internalOpen$, false);
      toast.success("Agent configuration saved");
    }
  } catch (error) {
    throwIfAbort(error);
    const message = error instanceof Error ? error.message : "Failed to save";
    L.error("Failed to save config:", error);
    set(internalSaveError$, message);
  } finally {
    set(internalSaving$, false);
  }
});
