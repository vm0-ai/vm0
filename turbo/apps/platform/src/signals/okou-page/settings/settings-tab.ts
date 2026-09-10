import { command, computed, state } from "ccstate";
import type { Tone } from "../../../views/okou-page/tone-constants.ts";
import { onRejection, withCleanup } from "../../utils.ts";
import {
  currentAgentVisibleWorkflows$,
  reloadWorkflows$,
} from "../../workflows-page/workflows-signals.ts";

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

type WorkflowRescue = readonly [workflowId: string, toAgentId: string];

export interface AgentDeleteWorkflow {
  readonly id: string;
  readonly title: string;
}

export interface AgentDeleteSession {
  readonly id: symbol;
  readonly agentId: string;
  readonly owner: AbortSignal;
  readonly open: boolean;
  readonly choices: Record<string, string>;
  readonly workflows: readonly AgentDeleteWorkflow[];
  readonly completedRescues: readonly WorkflowRescue[];
  readonly phase: "idle" | "copying" | "deleting";
  readonly error: unknown;
}

const internalAgentDeleteSession$ = state<AgentDeleteSession | null>(null);
export const agentDeleteSession$ = computed((get) => {
  return get(internalAgentDeleteSession$);
});

/** Fresh confirmations retain acknowledged copies from this agent page, not drafts. */
export const setAgentDeleteDialogOpen$ = command(
  (
    { get, set },
    {
      agentId,
      workflows,
    }: {
      agentId: string;
      workflows: readonly AgentDeleteWorkflow[] | undefined;
    },
    open: boolean,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const previous = get(internalAgentDeleteSession$);
    const sameOwner =
      previous?.agentId === agentId && previous.owner === signal;
    if (!open) {
      if (sameOwner && previous.phase === "idle") {
        set(internalAgentDeleteSession$, {
          ...previous,
          open: false,
          choices: {},
          error: null,
        });
        return true;
      }
      return false;
    }
    if (sameOwner && previous.open) {
      return true;
    }
    if (previous?.owner !== signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (get(internalAgentDeleteSession$)?.owner === signal) {
            set(internalAgentDeleteSession$, null);
          }
        },
        { once: true },
      );
    }
    set(internalAgentDeleteSession$, {
      id: Symbol("agent-delete"),
      agentId,
      owner: signal,
      open: true,
      choices: {},
      workflows: workflows ?? (sameOwner ? previous.workflows : []),
      completedRescues: sameOwner ? previous.completedRescues : [],
      phase: "idle",
      error: null,
    });
    return true;
  },
);

export const setAgentDeleteCopyChoices$ = command(
  (
    { get, set },
    sessionId: symbol,
    choices: Record<string, string>,
    workflows: readonly AgentDeleteWorkflow[],
  ) => {
    const session = get(internalAgentDeleteSession$);
    if (session?.id === sessionId && session.open && session.phase === "idle") {
      set(internalAgentDeleteSession$, { ...session, choices, workflows });
    }
  },
);

export const reloadAgentDeleteWorkflows$ = command(
  ({ get, set }, sessionId: symbol) => {
    const session = get(internalAgentDeleteSession$);
    if (session?.id === sessionId && session.open && session.phase === "idle") {
      session.owner.throwIfAborted();
      set(internalAgentDeleteSession$, { ...session, error: null });
      set(reloadWorkflows$);
    }
  },
);

export const deleteAgent$ = command(
  async (
    { get, set },
    {
      sessionId,
      deleteFn,
      copyWorkflow,
      workflowIds,
    }: {
      readonly sessionId: symbol;
      readonly deleteFn: () => Promise<void>;
      readonly copyWorkflow?: (
        workflowId: string,
        toAgentId: string,
      ) => Promise<void>;
      readonly workflowIds: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const session = get(internalAgentDeleteSession$);
    if (
      session?.id !== sessionId ||
      session.owner !== signal ||
      !session.open ||
      session.phase !== "idle"
    ) {
      return;
    }
    // Only this agent's workflows can be rescued. Completed source/destination
    // pairs survive retries and ordinary reopenings on the same agent page.
    const rescues = Object.entries(session.choices).filter(
      ([workflowId, toAgentId]) => {
        return (
          toAgentId !== "__delete_with_agent__" &&
          workflowIds.includes(workflowId) &&
          !session.completedRescues.some(([copiedId, copiedTo]) => {
            return copiedId === workflowId && copiedTo === toAgentId;
          })
        );
      },
    );
    set(internalAgentDeleteSession$, {
      ...session,
      phase: copyWorkflow && rescues.length > 0 ? "copying" : "deleting",
      error: null,
    });
    await withCleanup(
      onRejection(
        (async () => {
          // Never start a rescue from an unavailable source-workflow list.
          await get(currentAgentVisibleWorkflows$);
          signal.throwIfAborted();
          if (copyWorkflow) {
            for (const [workflowId, toAgentId] of rescues) {
              await copyWorkflow(workflowId, toAgentId);
              signal.throwIfAborted();
              const current = get(internalAgentDeleteSession$);
              if (current?.id !== sessionId) {
                return;
              }
              set(internalAgentDeleteSession$, {
                ...current,
                completedRescues: [
                  ...current.completedRescues,
                  [workflowId, toAgentId],
                ],
              });
              // Copying refreshes the workflow list. Settle that read before
              // another copy or deletion, while retaining its acknowledgement
              // if the refresh fails.
              await get(currentAgentVisibleWorkflows$);
              signal.throwIfAborted();
            }
          }
          const current = get(internalAgentDeleteSession$);
          if (current?.id !== sessionId) {
            return;
          }
          set(internalAgentDeleteSession$, { ...current, phase: "deleting" });
          await deleteFn();
          signal.throwIfAborted();
        })(),
        (error) => {
          signal.throwIfAborted();
          const current = get(internalAgentDeleteSession$);
          if (current?.id === sessionId) {
            set(internalAgentDeleteSession$, { ...current, error });
          }
        },
      ),
      () => {
        const current = get(internalAgentDeleteSession$);
        if (current?.id === sessionId) {
          set(internalAgentDeleteSession$, {
            ...current,
            phase: "idle",
            choices: {},
          });
        }
      },
    );
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
