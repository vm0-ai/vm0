import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroAgentInstructionsContract } from "@vm0/core";
import { throwIfAbort } from "../../utils.ts";
import { zeroClient$ } from "../../api-client.ts";
import type { AgentInstructions } from "../agent-types.ts";
import { zeroJobDetail$, reloadJobDetail$ } from "./detail.ts";

// ---------------------------------------------------------------------------
// Agent instructions — reactive async computed
// ---------------------------------------------------------------------------

const internalInstructionsReload$ = state(0);

const reloadJobInstructions$ = command(({ set }) => {
  set(internalInstructionsReload$, (prev) => {
    return prev + 1;
  });
});

export const zeroJobInstructions$ = computed(
  async (get): Promise<AgentInstructions | null> => {
    get(internalInstructionsReload$);
    const detail = await get(zeroJobDetail$);
    if (!detail) {
      return null;
    }
    const client = get(zeroClient$)(zeroAgentInstructionsContract);
    const result = await client.get({ params: { id: detail.agentId } });
    if (result.status !== 200) {
      throw new Error(`Failed to fetch instructions (${result.status})`);
    }
    return result.body;
  },
);

// ---------------------------------------------------------------------------
// Instructions editing
// ---------------------------------------------------------------------------

const editedContent$ = state<string | null>(null);

export const zeroJobEditedContent$ = computed((get) => {
  return get(editedContent$);
});

export const zeroJobInstructionsDirty$ = computed(async (get) => {
  const edited = get(editedContent$);
  const instructions = await get(zeroJobInstructions$);
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

export const buildZeroJobInstructions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(zeroJobDetail$);
    signal.throwIfAborted();
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

      set(jobBuilding$, false);
      set(editedContent$, null);
      set(reloadJobInstructions$);
      set(reloadJobDetail$);
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
