import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import {
  zeroOnboardingStatus$,
  reloadOnboardingStatus$,
} from "./zero-onboarding.ts";
import { triggerAndPollComposeJob } from "./compose-job.ts";
import type { AgentInstructions } from "./agent-types.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { getInstructionsFilename } from "@vm0/core";
import { skillValueToUrl, skillUrlToValue } from "../../data/skills.ts";
import { zeroChatAgentId$ } from "./zero-nav.ts";

const L = logger("ZeroSkills");

// ---------------------------------------------------------------------------
// Instructions state (read-only, used by syncSkillsToCompose$)
// ---------------------------------------------------------------------------

interface InstructionsState {
  instructions: AgentInstructions | null;
  loading: boolean;
  error: string | null;
}

const instructionsState$ = state<InstructionsState>({
  instructions: null,
  loading: false,
  error: null,
});

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
  const resp = await fetchFn(`/api/agent/composes/${composeId}`);
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

/** Skills seeded from compose content. */
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

// ---------------------------------------------------------------------------
// Shared helper: resolve current instructions content
// ---------------------------------------------------------------------------

async function resolveInstructionsContent(
  fetchFn: typeof fetch,
  composeId: string | undefined,
  localContent: string | null | undefined,
): Promise<string | undefined> {
  let raw: string | undefined;
  if (localContent) {
    raw = localContent;
  } else if (composeId) {
    const resp = await fetchFn(`/api/agent/composes/${composeId}/instructions`);
    if (!resp.ok) {
      L.warn(
        `Failed to fetch instructions for compose ${composeId}: ${resp.status} ${resp.statusText}`,
      );
      return undefined;
    }
    const data = (await resp.json()) as AgentInstructions;
    raw = data.content ?? undefined;
  }
  return raw ?? undefined;
}

// ---------------------------------------------------------------------------
// Shared helper: build compose and update default agent reference
// ---------------------------------------------------------------------------

async function buildAndSetDefaultAgent(
  fetchFn: typeof fetch,
  newContent: ZeroComposeContent,
  instructions?: string,
): Promise<void> {
  const agentKey = Object.keys(newContent.agents)[0];
  const agent = agentKey ? newContent.agents[agentKey] : undefined;
  const resolvedInstructions = instructions ?? "";
  const contentWithInstructions: ZeroComposeContent =
    agentKey && agent && !("instructions" in agent)
      ? {
          ...newContent,
          agents: {
            ...newContent.agents,
            [agentKey]: {
              ...agent,
              instructions: getInstructionsFilename(agent.framework),
            },
          },
        }
      : newContent;

  const job = await triggerAndPollComposeJob(
    fetchFn,
    contentWithInstructions,
    resolvedInstructions,
  );
  if (!job.result) {
    throw new Error("Build completed without result");
  }

  const resp = await fetchFn("/api/orgs/default-agent", {
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
      throw new Error("No compose content available");
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
    const instructions = await resolveInstructionsContent(
      fetchFn,
      compose.id,
      get(instructionsState$).instructions?.content,
    );
    await buildAndSetDefaultAgent(fetchFn, newContent, instructions);
    await set(reloadOnboardingStatus$);
    set(internalComposeReload$, (x) => x + 1);
  },
);
