import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import {
  zeroOnboardingStatus$,
  reloadOnboardingStatus$,
} from "./zero-onboarding.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { triggerAndPollComposeJob } from "../agent-detail/compose-job.ts";
import { skillValueToUrl, skillUrlToValue } from "../../data/skills.ts";

const L = logger("ZeroMeet");

// ---------------------------------------------------------------------------
// Default agent compose
// ---------------------------------------------------------------------------

const zeroComposeId$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentComposeId;
});

interface ZeroAgentDef {
  framework: string;
  skills?: string[];
  [key: string]: unknown;
}

interface ZeroComposeContent {
  version: string;
  agents: Record<string, ZeroAgentDef>;
}

interface ZeroCompose {
  id: string;
  name: string;
  headVersionId: string | null;
  content: ZeroComposeContent | null;
}

const internalComposeReload$ = state(0);

const zeroCompose$ = computed(async (get) => {
  get(internalComposeReload$);
  const composeId = await get(zeroComposeId$);
  if (!composeId) {
    return null;
  }

  const fetchFn = get(fetch$);
  const resp = await fetchFn(`/api/agent/composes/${composeId}`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch compose: ${resp.statusText}`);
  }
  return (await resp.json()) as ZeroCompose;
});

// ---------------------------------------------------------------------------
// Settings: update agent name via compose content
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const zeroSettingsSaving$ = computed((get) => get(internalSaving$));

// ---------------------------------------------------------------------------
// Skills list: derived from compose content, synced via compose jobs
// ---------------------------------------------------------------------------

const internalAddedSkills$ = state<string[]>([]);

/** Skills seeded from compose content. Returns compose skills when local list is empty. */
const seededSkills$ = computed(async (get) => {
  const compose = await get(zeroCompose$);
  if (!compose?.content) {
    return [];
  }
  const agentKey = Object.keys(compose.content.agents)[0];
  if (!agentKey) {
    return [];
  }
  const agent = compose.content.agents[agentKey];
  return (agent?.skills ?? []).map(skillUrlToValue);
});

/** Added skills: local overrides take precedence, otherwise seeded from compose. */
export const zeroAddedSkills$ = computed(async (get) => {
  const local = get(internalAddedSkills$);
  if (local.length > 0) {
    return local;
  }
  return await get(seededSkills$);
});

/** Add a skill: update compose content and trigger compose job. */
export const addZeroSkill$ = command(async ({ get, set }, name: string) => {
  // Ensure internal state is populated from compose before mutating
  if (get(internalAddedSkills$).length === 0) {
    const seeded = await get(seededSkills$);
    if (seeded.length > 0) {
      set(internalAddedSkills$, seeded);
    }
  }
  // Optimistic update
  set(internalAddedSkills$, (prev) => [...prev, name]);

  set(internalSaving$, true);
  try {
    const newSkills = get(internalAddedSkills$);
    await set(syncSkillsToCompose$, newSkills);
  } catch (error) {
    throwIfAbort(error);
    // Rollback on failure
    set(internalAddedSkills$, (prev) => prev.filter((s) => s !== name));
    L.error("Failed to add skill:", error);
    toast.error(error instanceof Error ? error.message : "Failed to add skill");
  } finally {
    set(internalSaving$, false);
  }
});

/** Remove a skill: update compose content and trigger compose job. */
export const removeZeroSkill$ = command(async ({ get, set }, name: string) => {
  // Ensure internal state is populated from compose before mutating
  if (get(internalAddedSkills$).length === 0) {
    const seeded = await get(seededSkills$);
    if (seeded.length > 0) {
      set(internalAddedSkills$, seeded);
    }
  }
  const prev = get(internalAddedSkills$);
  // Optimistic update
  set(
    internalAddedSkills$,
    prev.filter((s) => s !== name),
  );

  set(internalSaving$, true);
  try {
    const newSkills = get(internalAddedSkills$);
    await set(syncSkillsToCompose$, newSkills);
  } catch (error) {
    throwIfAbort(error);
    // Rollback on failure
    set(internalAddedSkills$, prev);
    L.error("Failed to remove skill:", error);
    toast.error(
      error instanceof Error ? error.message : "Failed to remove skill",
    );
  } finally {
    set(internalSaving$, false);
  }
});

// ---------------------------------------------------------------------------
// Shared helper: build compose and update default agent reference
// ---------------------------------------------------------------------------

async function buildAndSetDefaultAgent(
  fetchFn: typeof fetch,
  newContent: ZeroComposeContent,
): Promise<void> {
  const job = await triggerAndPollComposeJob(fetchFn, newContent);
  if (!job.result) {
    throw new Error("Build completed without result");
  }

  const resp = await fetchFn("/api/scopes/default-agent", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentComposeId: job.result.composeId }),
  });

  if (!resp.ok) {
    const err = (await resp.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      err?.error?.message ?? `Failed to update: ${resp.statusText}`,
    );
  }
}

/** Sync the skills list to compose content via compose job. */
const syncSkillsToCompose$ = command(
  async ({ get, set }, skillValues: string[]) => {
    const compose = await get(zeroCompose$);
    if (!compose?.content) {
      throw new Error("No compose content found");
    }

    const agentKey = Object.keys(compose.content.agents)[0];
    if (!agentKey) {
      throw new Error("No agent found in compose");
    }

    const agent = compose.content.agents[agentKey];
    const newContent: ZeroComposeContent = {
      ...compose.content,
      agents: {
        [agentKey]: {
          ...agent,
          skills:
            skillValues.length > 0
              ? skillValues.map(skillValueToUrl)
              : undefined,
        },
      },
    };

    const fetchFn = get(fetch$);
    await buildAndSetDefaultAgent(fetchFn, newContent);
    await set(reloadOnboardingStatus$);
    set(internalComposeReload$, (x) => x + 1);
  },
);

// ---------------------------------------------------------------------------
// Settings: update agent name via compose content
// ---------------------------------------------------------------------------

export const zeroUpdateSettings$ = command(
  async ({ get, set }, newName: string) => {
    const compose = await get(zeroCompose$);
    if (!compose?.content) {
      throw new Error("No compose content found");
    }

    const content = compose.content;
    const oldName = Object.keys(content.agents)[0];
    if (!oldName) {
      throw new Error("No agent found in compose");
    }

    // Only update if name actually changed
    const nameChanged = oldName !== newName.toLowerCase();
    if (!nameChanged) {
      return;
    }

    set(internalSaving$, true);
    try {
      const agentConfig = content.agents[oldName];
      const newContent: ZeroComposeContent = {
        ...content,
        agents: { [newName.toLowerCase()]: agentConfig },
      };

      const fetchFn = get(fetch$);
      await buildAndSetDefaultAgent(fetchFn, newContent);

      await set(reloadOnboardingStatus$);
      set(internalComposeReload$, (x) => x + 1);
      toast.success("Settings saved");
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to update settings:", error);
      toast.error(error instanceof Error ? error.message : "Save failed");
    } finally {
      set(internalSaving$, false);
    }
  },
);
