import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroAgentInstructionsContract } from "@vm0/core";
import { throwIfAbort } from "../../utils.ts";
import { logger } from "../../log.ts";
import { zeroClient$ } from "../../api-client.ts";
import type { AgentInstructions } from "../agent-types.ts";
import { zeroJobDetail$, fetchZeroJobDetail$ } from "./detail.ts";

const L = logger("ZeroJobDetail");

// ---------------------------------------------------------------------------
// Agent instructions
// ---------------------------------------------------------------------------

interface ZeroJobInstructionsState {
  instructions: AgentInstructions | null;
  loading: boolean;
  error: string | null;
}

const instructionsState$ = state<ZeroJobInstructionsState>({
  instructions: null,
  loading: false,
  error: null,
});

export const zeroJobInstructions$ = computed((get) => {
  return get(instructionsState$).instructions;
});
export const zeroJobInstructionsLoading$ = computed((get) => {
  return get(instructionsState$).loading;
});
export const zeroJobInstructionsError$ = computed((get) => {
  return get(instructionsState$).error;
});

export const fetchZeroJobInstructions$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      return;
    }

    set(instructionsState$, { instructions: null, loading: true, error: null });

    try {
      const client = get(zeroClient$)(zeroAgentInstructionsContract);
      const result = await client.get({ params: { id: detail.agentId } });
      if (result.status !== 200) {
        throw new Error(`Failed to fetch instructions (${result.status})`);
      }

      set(instructionsState$, {
        instructions: result.body,
        loading: false,
        error: null,
      });
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to fetch instructions:", error);
      set(instructionsState$, {
        instructions: null,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load instructions",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Instructions editing
// ---------------------------------------------------------------------------

const editedContent$ = state<string | null>(null);

export const zeroJobEditedContent$ = computed((get) => {
  return get(editedContent$);
});

export const zeroJobInstructionsDirty$ = computed((get) => {
  const edited = get(editedContent$);
  const instructions = get(instructionsState$).instructions;
  const savedBody = instructions?.content ?? "";
  return edited !== null && edited.trim() !== savedBody.trim();
});

export const setZeroJobEditedContent$ = command(({ set }, value: string) => {
  set(editedContent$, value);
});

export const discardZeroJobEdit$ = command(({ set }) => {
  set(editedContent$, null);
});

const jobBuilding$ = state(false);
export const zeroJobBuilding$ = computed((get) => {
  return get(jobBuilding$);
});

const internalBuildError$ = state<string | null>(null);
export const zeroJobBuildError$ = computed((get) => {
  return get(internalBuildError$);
});

/** Reset instructions state to initial values. */
export const resetInstructionsState$ = command(({ set }) => {
  set(instructionsState$, {
    instructions: null,
    loading: false,
    error: null,
  });
  set(editedContent$, null);
  set(internalBuildError$, null);
  set(jobBuilding$, false);
});

export const buildZeroJobInstructions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = get(zeroJobDetail$);
    const raw = get(editedContent$);
    if (!detail?.agentId || raw === null) {
      return;
    }
    const edited = raw.trim();

    set(jobBuilding$, true);
    set(internalBuildError$, null);

    try {
      const client = get(zeroClient$)(zeroAgentInstructionsContract);
      const result = await client.update({
        params: { id: detail.agentId },
        body: { content: edited },
      });
      signal.throwIfAborted();

      if (result.status !== 200) {
        const errorDetail =
          result.status === 401 ||
          result.status === 403 ||
          result.status === 404 ||
          result.status === 422
            ? result.body.error.message
            : `status ${result.status}`;
        throw new Error(`Build failed: ${errorDetail}`);
      }

      // Clear building state before content updates so the editor remounts
      // with editable=true. Setting jobBuilding$, instructionsState$, and
      // editedContent$ in the same synchronous block batches them into a
      // single render — the editor key changes and the new editor starts
      // editable immediately.
      set(jobBuilding$, false);

      const current = get(instructionsState$).instructions;
      set(instructionsState$, {
        instructions: { content: edited, filename: current?.filename ?? null },
        loading: false,
        error: null,
      });

      set(editedContent$, null);
      await set(fetchZeroJobDetail$, signal);
      toast.success("Instructions saved");
    } catch (error) {
      throwIfAbort(error);
      set(
        internalBuildError$,
        "Failed to build instructions. Please try again.",
      );
    } finally {
      set(jobBuilding$, false);
    }
  },
);
