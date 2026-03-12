import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import {
  zeroOnboardingStatus$,
  reloadOnboardingStatus$,
} from "./zero-onboarding.ts";
import { triggerAndPollComposeJob } from "../agent-detail/compose-job.ts";
import type { AgentInstructions } from "../agent-detail/types.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { getInstructionsFilename, stripMetadataFrontmatter } from "@vm0/core";
import { skillValueToUrl, skillUrlToValue } from "../../data/skills.ts";

const L = logger("ZeroMeet");

// ---------------------------------------------------------------------------
// Instructions state
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

export const zeroInstructions$ = computed(
  (get) => get(instructionsState$).instructions,
);
export const zeroInstructionsLoading$ = computed(
  (get) => get(instructionsState$).loading,
);
export const zeroFetchError$ = computed((get) => get(instructionsState$).error);

// ---------------------------------------------------------------------------
// Default agent compose
// ---------------------------------------------------------------------------

const zeroComposeId$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentComposeId;
});

interface ZeroAgentMetadata {
  displayName?: string;
  sound?: string;
}

interface ZeroAgentDef {
  framework: string;
  skills?: string[];
  metadata?: ZeroAgentMetadata;
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
// Fetch instructions
// ---------------------------------------------------------------------------

export const fetchZeroInstructions$ = command(async ({ get, set }) => {
  const status = await get(zeroOnboardingStatus$);
  const composeId = status.defaultAgentComposeId;
  if (!composeId) {
    return;
  }

  set(instructionsState$, { instructions: null, loading: true, error: null });

  const fetchFn = get(fetch$);

  // Fetch instructions and compose detail in parallel
  const [instrResp, composeResp] = await Promise.all([
    fetchFn(`/api/agent/composes/${composeId}/instructions`),
    fetchFn(`/api/agent/composes/${composeId}`),
  ]);

  if (!instrResp.ok || !composeResp.ok) {
    set(instructionsState$, {
      instructions: null,
      loading: false,
      error: "Failed to load instructions.",
    });
    return;
  }

  const instrData = (await instrResp.json()) as AgentInstructions;
  set(instructionsState$, {
    instructions: instrData,
    loading: false,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Editing state
// ---------------------------------------------------------------------------

const editedContent$ = state<string | null>(null);

export const zeroEditedContent$ = computed((get) => get(editedContent$));

export const zeroInstructionsDirty$ = computed((get) => {
  const edited = get(editedContent$);
  const instructions = get(instructionsState$).instructions;
  const savedBody = stripMetadataFrontmatter(instructions?.content ?? "");
  return edited !== null && edited !== savedBody;
});

export const setZeroEditedContent$ = command(({ set }, value: string) => {
  set(editedContent$, value);
});

export const discardZeroEdit$ = command(({ set }) => {
  set(editedContent$, null);
});

// ---------------------------------------------------------------------------
// Build instructions
// ---------------------------------------------------------------------------

const building$ = state(false);
export const zeroBuildingInstructions$ = computed((get) => get(building$));

const internalBuildError$ = state<string | null>(null);
export const zeroBuildError$ = computed((get) => get(internalBuildError$));

export const buildZeroInstructions$ = command(async ({ get, set }) => {
  const compose = await get(zeroCompose$);
  const edited = get(editedContent$);
  if (!compose?.content || edited === null) {
    return;
  }

  set(building$, true);
  set(internalBuildError$, null);

  try {
    const fetchFn = get(fetch$);

    // Ensure compose content includes instructions field so the CLI uploads it
    const agentKey = Object.keys(compose.content.agents)[0];
    const agent = agentKey ? compose.content.agents[agentKey] : undefined;
    const contentWithInstructions: ZeroComposeContent =
      agentKey && agent
        ? {
            ...compose.content,
            agents: {
              ...compose.content.agents,
              [agentKey]: {
                ...agent,
                instructions: getInstructionsFilename(agent.framework),
              },
            },
          }
        : compose.content;

    const job = await triggerAndPollComposeJob(
      fetchFn,
      contentWithInstructions,
      edited,
    );
    if (!job.result) {
      throw new Error("Build completed without result");
    }

    // Update default agent to point to the new compose
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

    // Reload onboarding status so composeId is up-to-date on next fetch
    await set(reloadOnboardingStatus$);
    set(internalComposeReload$, (x) => x + 1);

    // Optimistically update instructions state
    const current = get(instructionsState$).instructions;
    set(instructionsState$, {
      instructions: { content: edited, filename: current?.filename ?? null },
      loading: false,
      error: null,
    });

    // Clear editing state
    set(editedContent$, null);

    L.debug("Zero instructions built successfully");
  } catch (error) {
    throwIfAbort(error);
    set(internalBuildError$, "Failed to build instructions. Please try again.");
  } finally {
    set(building$, false);
  }
});

// ---------------------------------------------------------------------------
// Settings: update agent name via compose content
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const zeroSettingsSaving$ = computed((get) => get(internalSaving$));

// ---------------------------------------------------------------------------
// Skills list: derived from compose content, synced via compose jobs
// ---------------------------------------------------------------------------

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

/** Whether local skills differ from the saved compose skills. */
export const zeroSkillsDirty$ = computed(async (get) => {
  const local = get(internalAddedSkills$);
  if (local === null) {
    return false;
  }
  const seeded = await get(seededSkills$);
  if (local.length !== seeded.length) {
    return true;
  }
  const sorted = [...local].sort();
  const seededSorted = [...seeded].sort();
  return sorted.some((s, i) => s !== seededSorted[i]);
});

/** Add a skill (local only, no compose job). */
export const addZeroSkill$ = command(async ({ get, set }, name: string) => {
  if (get(internalAddedSkills$) === null) {
    set(internalAddedSkills$, await get(seededSkills$));
  }
  set(internalAddedSkills$, (prev) => [...(prev ?? []), name]);
});

/** Remove a skill (local only, no compose job). */
export const removeZeroSkill$ = command(async ({ get, set }, name: string) => {
  if (get(internalAddedSkills$) === null) {
    set(internalAddedSkills$, await get(seededSkills$));
  }
  set(internalAddedSkills$, (prev) => (prev ?? []).filter((s) => s !== name));
});

/** Discard local skill changes and revert to saved compose skills. */
export const discardZeroSkills$ = command(({ set }) => {
  set(internalAddedSkills$, null);
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

/**
 * Get the current instructions content, fetching from API if not already loaded.
 * This ensures compose jobs always include the instructions file when the
 * compose content references one (e.g., instructions: "CLAUDE.md").
 */
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
  // Strip any existing metadata (legacy frontmatter or profile block)
  // so the server can inject a clean copy from compose metadata.
  return raw ? stripMetadataFrontmatter(raw) : undefined;
}

// ---------------------------------------------------------------------------
// Shared helper: build compose and update default agent reference
// ---------------------------------------------------------------------------

async function buildAndSetDefaultAgent(
  fetchFn: typeof fetch,
  newContent: ZeroComposeContent,
  instructions?: string,
): Promise<void> {
  // Ensure instructions field is present when we have content to write.
  // Fall back to empty string so the server creates a CLAUDE.md with
  // agent profile even when there are no user-written instructions.
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

// ---------------------------------------------------------------------------
// Settings: update agent name via compose content
// ---------------------------------------------------------------------------

interface ZeroSettingsUpdate {
  displayName?: string;
  sound?: string;
}

export const zeroUpdateSettings$ = command(
  async ({ get, set }, update: ZeroSettingsUpdate) => {
    const compose = await get(zeroCompose$);
    if (!compose?.content) {
      throw new Error("No compose content found");
    }

    const content = compose.content;
    const agentKey = Object.keys(content.agents)[0];
    if (!agentKey) {
      throw new Error("No agent found in compose");
    }

    const agentConfig = content.agents[agentKey];
    const currentMetadata = agentConfig.metadata ?? {};
    const newMetadata: ZeroAgentMetadata = { ...currentMetadata };
    if (update.displayName !== undefined) {
      newMetadata.displayName = update.displayName;
    }
    if (update.sound !== undefined) {
      newMetadata.sound = update.sound;
    }

    // Skip if nothing changed
    if (
      newMetadata.displayName === currentMetadata.displayName &&
      newMetadata.sound === currentMetadata.sound
    ) {
      return;
    }

    set(internalSaving$, true);
    try {
      const newContent: ZeroComposeContent = {
        ...content,
        agents: {
          [agentKey]: { ...agentConfig, metadata: newMetadata },
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
      // Refresh instructions so the profile block reflects the new settings
      await set(fetchZeroInstructions$);
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
