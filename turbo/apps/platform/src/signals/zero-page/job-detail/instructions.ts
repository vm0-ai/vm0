import { command, computed, state } from "ccstate";
import { zeroAgentInstructionsContract } from "@vm0/core";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
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
    const result = await accept(
      client.get({ params: { id: detail.agentId } }),
      [200],
    );
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

export const buildZeroJobInstructions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(zeroJobDetail$);
    signal.throwIfAborted();
    const raw = get(editedContent$);
    if (!detail?.agentId || raw === null) {
      return;
    }
    const edited = raw.trim();

    const client = get(zeroClient$)(zeroAgentInstructionsContract);
    await accept(
      client.update({
        params: { id: detail.agentId },
        body: { content: edited },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(editedContent$, null);
    set(reloadJobInstructions$);
    set(reloadJobDetail$);
  },
);
