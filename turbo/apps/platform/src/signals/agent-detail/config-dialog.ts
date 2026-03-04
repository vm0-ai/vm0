import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { stringify, parse } from "yaml";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import {
  agentDetail$,
  agentInstructions$,
  editedContent$,
  fetchAgentDetail$,
  refreshAgentInstructions$,
} from "./agent-detail.ts";
import { triggerAndPollComposeJob } from "./compose-job.ts";
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
// Building state (async compose job in progress)
// ---------------------------------------------------------------------------

const internalBuilding$ = state(false);
export const configDialogBuilding$ = computed((get) => get(internalBuilding$));

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
  if (!AGENT_NAME_REGEX.test(firstKey)) {
    return false;
  }
  // Agent name cannot be changed — reject if it differs from the original
  const detail = get(agentDetail$);
  if (detail && firstKey !== detail.name) {
    return false;
  }
  return true;
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

export const updateYamlText$ = command(({ get, set }, text: string) => {
  set(internalYamlText$, text);

  try {
    const parsed = parse(text) as ComposeContent;

    // Basic validation: must have version and agents
    if (!parsed || typeof parsed !== "object" || !parsed.agents) {
      set(internalYamlError$, "Invalid YAML: must contain 'agents' field");
      return;
    }

    // Agent name cannot be changed via YAML editing
    const detail = get(agentDetail$);
    if (detail) {
      const newAgentKey = Object.keys(parsed.agents)[0];
      if (newAgentKey && newAgentKey !== detail.name) {
        set(
          internalYamlError$,
          "Agent name cannot be changed. Create a new agent instead.",
        );
        return;
      }
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
// Build — POST to /api/compose/jobs and poll for completion
// ---------------------------------------------------------------------------

export const buildConfigDialog$ = command(async ({ get, set }) => {
  const compose = get(internalEditableCompose$);
  const detail = get(agentDetail$);
  if (!compose || !detail) {
    return;
  }

  set(internalBuilding$, true);
  set(internalSaveError$, null);

  try {
    const fetchFn = get(fetch$);

    // Include current instructions text if available
    const edited = get(editedContent$);
    const instructions =
      edited ?? get(agentInstructions$)?.content ?? undefined;

    await triggerAndPollComposeJob(fetchFn, compose, instructions);

    await set(fetchAgentDetail$);
    await set(refreshAgentInstructions$);
    set(internalOpen$, false);
    toast.success("Agent built successfully");
  } catch (error) {
    throwIfAbort(error);
    const message = error instanceof Error ? error.message : "Failed to build";
    L.error("Failed to build config:", error);
    set(internalSaveError$, message);
  } finally {
    set(internalBuilding$, false);
  }
});
