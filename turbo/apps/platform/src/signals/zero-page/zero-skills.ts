import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import {
  zeroOnboardingStatus$,
  reloadOnboardingStatus$,
} from "./zero-onboarding.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { skillUrlToValue } from "../../data/skills.ts";
import { SEED_SKILLS } from "../../data/the-seed.ts";
import { zeroChatAgentId$ } from "./zero-nav.ts";

const L = logger("ZeroSkills");

// ---------------------------------------------------------------------------
// Default agent compose
// ---------------------------------------------------------------------------

const zeroComposeId$ = computed(async (get) => {
  const chatAgentId = get(zeroChatAgentId$);
  if (chatAgentId !== null) {
    return chatAgentId;
  }
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

/** Bump to force `zeroCompose$` to re-fetch from the API. */
export const reloadZeroCompose$ = command(({ set }) => {
  set(internalComposeReload$, (x) => x + 1);
});

const zeroCompose$ = computed(async (get) => {
  get(internalComposeReload$);
  const composeId = await get(zeroComposeId$);
  if (!composeId) {
    return null;
  }

  const fetchFn = get(fetch$);
  const resp = await fetchFn(`/api/zero/composes/${composeId}`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch compose: ${resp.statusText}`);
  }
  return (await resp.json()) as ZeroCompose;
});

// ---------------------------------------------------------------------------
// Skills list: derived from compose content, synced via compose jobs
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);

// null = not initialized (fallback to seeded), string[] = user's local draft
const internalAddedSkills$ = state<string[] | null>(null);

/** Skills seeded from compose content, always includes default seed skills. */
const seededSkills$ = computed(async (get) => {
  const compose = await get(zeroCompose$);
  const fromContent: string[] = [];
  if (compose?.content) {
    const agentKey = Object.keys(compose.content.agents)[0];
    if (agentKey) {
      const agent = compose.content.agents[agentKey];
      fromContent.push(...(agent?.skills ?? []).map(skillUrlToValue));
    }
  }
  return [...new Set([...SEED_SKILLS, ...fromContent])];
});

/** Added skills: local draft takes precedence, otherwise seeded from compose. */
export const zeroAddedSkills$ = computed(async (get) => {
  const local = get(internalAddedSkills$);
  if (local !== null) {
    return local;
  }
  return await get(seededSkills$);
});

/** Add a skill (local only, no compose job). */
export const addZeroSkill$ = command(async ({ get, set }, name: string) => {
  if (get(internalAddedSkills$) === null) {
    set(internalAddedSkills$, await get(seededSkills$));
  }
  set(internalAddedSkills$, (prev) => [...(prev ?? []), name]);
});

/** Save skill changes: trigger compose job and wait for completion. */
export const saveZeroSkills$ = command(async ({ get, set }) => {
  set(internalSaving$, true);
  try {
    const newSkills = get(internalAddedSkills$) ?? [];
    await set(syncSkillsToCompose$, newSkills);
    // Reset to null so seeded picks up the new compose state
    set(internalAddedSkills$, null);
    toast.success("Skills saved");
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to save skills:", error);
    toast.error(
      error instanceof Error ? error.message : "Failed to save skills",
    );
  } finally {
    set(internalSaving$, false);
  }
});

/** Sync the skills list via zero agents API. */
const syncSkillsToCompose$ = command(
  async ({ get, set }, skillValues: string[]) => {
    const compose = await get(zeroCompose$);
    if (!compose?.content) {
      throw new Error("No compose content available");
    }

    const fetchFn = get(fetch$);

    const resp = await fetchFn(
      `/api/zero/agents/${encodeURIComponent(compose.name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectors: skillValues }),
      },
    );

    if (!resp.ok) {
      const errorData = (await resp.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        errorData?.error?.message ?? `Save failed: ${resp.statusText}`,
      );
    }

    await set(reloadOnboardingStatus$);
    set(internalComposeReload$, (x) => x + 1);
  },
);
