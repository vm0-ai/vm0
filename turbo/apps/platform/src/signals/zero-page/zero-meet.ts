import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { triggerAndPollComposeJob } from "../agent-detail/compose-job.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("ZeroMeet");

// ---------------------------------------------------------------------------
// Instructions state
// ---------------------------------------------------------------------------

interface InstructionsData {
  content: string | null;
  filename: string | null;
}

interface InstructionsState {
  instructions: InstructionsData | null;
  loading: boolean;
}

const instructionsState$ = state<InstructionsState>({
  instructions: null,
  loading: false,
});

export const zeroInstructions$ = computed(
  (get) => get(instructionsState$).instructions,
);
export const zeroInstructionsLoading$ = computed(
  (get) => get(instructionsState$).loading,
);

// ---------------------------------------------------------------------------
// Compose detail (needed for build)
// ---------------------------------------------------------------------------

interface ComposeDetail {
  composeId: string;
  name: string;
  content: object | null;
}

const composeDetail$ = state<ComposeDetail | null>(null);

// ---------------------------------------------------------------------------
// Fetch instructions
// ---------------------------------------------------------------------------

export const fetchZeroInstructions$ = command(async ({ get, set }) => {
  const status = await get(zeroOnboardingStatus$);
  const composeId = status.defaultAgentComposeId;
  if (!composeId) {
    return;
  }

  set(instructionsState$, { instructions: null, loading: true });

  const fetchFn = get(fetch$);

  // Fetch instructions and compose detail in parallel
  const [instrResp, composeResp] = await Promise.all([
    fetchFn(`/api/agent/composes/${composeId}/instructions`),
    fetchFn(`/api/agent/composes/${composeId}`),
  ]);

  if (instrResp.ok) {
    const data = (await instrResp.json()) as InstructionsData;
    set(instructionsState$, { instructions: data, loading: false });
  } else {
    set(instructionsState$, { instructions: null, loading: false });
  }

  if (composeResp.ok) {
    const compose = (await composeResp.json()) as {
      id: string;
      name: string;
      content: object | null;
    };
    set(composeDetail$, {
      composeId: compose.id,
      name: compose.name,
      content: compose.content,
    });
  }
});

// ---------------------------------------------------------------------------
// Editing state
// ---------------------------------------------------------------------------

const editedContent$ = state<string | null>(null);

export const zeroEditedContent$ = computed((get) => get(editedContent$));

export const zeroInstructionsDirty$ = computed((get) => {
  const edited = get(editedContent$);
  const instructions = get(instructionsState$).instructions;
  return edited !== null && edited !== (instructions?.content ?? "");
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

export const buildZeroInstructions$ = command(async ({ get, set }) => {
  const detail = get(composeDetail$);
  const edited = get(editedContent$);
  if (!detail?.content || edited === null) {
    return;
  }

  set(building$, true);

  try {
    const fetchFn = get(fetch$);
    await triggerAndPollComposeJob(fetchFn, detail.content, edited);

    // Optimistically update instructions state
    const current = get(instructionsState$).instructions;
    set(instructionsState$, {
      instructions: { content: edited, filename: current?.filename ?? null },
      loading: false,
    });

    // Clear editing state
    set(editedContent$, null);

    L.debug("Zero instructions built successfully");
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to build instructions:", error);
  } finally {
    set(building$, false);
  }
});
