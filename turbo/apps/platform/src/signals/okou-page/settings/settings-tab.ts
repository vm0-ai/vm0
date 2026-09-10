import { command, computed, state } from "ccstate";
import type { Tone } from "../../../views/okou-page/tone-constants.ts";
import { withCleanup } from "../../utils.ts";

interface SettingsFormValues {
  name: string;
  description: string;
  tone: Tone;
  avatarUrl: string | null;
  visibility: "public" | "private";
}

interface SettingsFormDraft {
  readonly agentId: string;
  readonly patch: Partial<SettingsFormValues>;
}

const internalSettingsFormDraft$ = state<SettingsFormDraft | null>(null);

export const settingsFormDraft$ = computed((get) => {
  return get(internalSettingsFormDraft$);
});

export const patchSettingsForm$ = command(
  (
    { set },
    input: {
      readonly agentId: string;
      readonly patch: Partial<SettingsFormValues>;
    },
  ) => {
    set(internalSettingsFormDraft$, (draft) => {
      if (!draft || draft.agentId !== input.agentId) {
        return { agentId: input.agentId, patch: input.patch };
      }
      return { ...draft, patch: { ...draft.patch, ...input.patch } };
    });
  },
);

export const resetSettingsForm$ = command(({ set }) => {
  set(internalSettingsFormDraft$, null);
});

// ---------------------------------------------------------------------------
// Delete agent command
// ---------------------------------------------------------------------------

export const deleteAgent$ = command(
  async (
    { set },
    {
      deleteFn,
      copyWorkflow,
      rescues,
    }: {
      readonly deleteFn: () => Promise<void>;
      readonly copyWorkflow?: (
        workflowId: string,
        toAgentId: string,
      ) => Promise<void>;
      readonly rescues: readonly (readonly [string, string])[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (copyWorkflow && rescues.length > 0) {
      set(internalDeleteCopying$, true);
      await withCleanup(
        (async () => {
          for (const [workflowId, toAgentId] of rescues) {
            await copyWorkflow(workflowId, toAgentId);
            signal.throwIfAborted();
          }
        })(),
        () => {
          set(internalDeleteCopying$, false);
        },
      );
    }
    await deleteFn();
  },
);

// ---------------------------------------------------------------------------
// Destructive-action confirmation state
// ---------------------------------------------------------------------------

/** Whether the public → private confirmation dialog is open. */
const internalDemoteConfirmOpen$ = state<boolean>(false);
export const agentDemoteConfirmOpen$ = computed((get) => {
  return get(internalDemoteConfirmOpen$);
});
export const setAgentDemoteConfirmOpen$ = command(({ set }, open: boolean) => {
  set(internalDemoteConfirmOpen$, open);
});

/**
 * Per-workflow delete-reconcile choices, keyed by workflow id. A value is a
 * target agent id to copy the workflow onto before deleting the agent, or the
 * DELETE_WITH_AGENT sentinel to let it be removed with the agent.
 */
const internalDeleteCopyChoices$ = state<Record<string, string>>({});
export const agentDeleteCopyChoices$ = computed((get) => {
  return get(internalDeleteCopyChoices$);
});
export const setAgentDeleteCopyChoices$ = command(
  ({ set }, choices: Record<string, string>) => {
    set(internalDeleteCopyChoices$, choices);
  },
);

/** Whether workflows are being copied off the agent before it is deleted. */
const internalDeleteCopying$ = state<boolean>(false);
export const agentDeleteCopying$ = computed((get) => {
  return get(internalDeleteCopying$);
});
