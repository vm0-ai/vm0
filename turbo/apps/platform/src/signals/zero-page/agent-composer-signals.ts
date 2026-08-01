import { command, computed } from "ccstate";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import {
  currentChatAgentDisplayName$,
  currentChatAgentId$,
} from "../agent-chat.ts";
import { sendNewThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import {
  CREATE_WORKFLOW_WITH_CHAT_PROMPT,
  replaceWorkflowPromptDraftTarget$,
  setReplaceWorkflowPromptDraftTarget$,
} from "../chat-page/workflow-prompt-action.ts";
import { updateUserModelPreference$ } from "../external/user-model-preference.ts";
import { queueCurrentAgentDraftSync$ } from "./agent-draft.ts";
import { talkDraft$, type DraftSignals } from "./chat-draft.ts";
import {
  computerUseHosts$,
  selectedComputerUseHostId,
} from "./computer-use-hosts.ts";
import {
  createComposerFileInputSignals,
  createComposerSignals,
  type ComposerPendingEvent,
  type ComposerSubmission,
} from "./composer-signals.ts";
import {
  chatPageComposerConnectors,
  chatPageModelSelection$,
  chatPageSelectedModelOauthAvailable$,
  chatPageWorkflowComposer$,
  configureChatPageSelectedModel$,
  resetChatPageModelSelection$,
  setChatPageModelSelection$,
  updateCodexFastModeDefaultForSelection$,
} from "./zero-chat-page.ts";
import {
  newThreadComputerAccess$,
  newThreadGenerationTemplate$,
  resetNewThreadComputerAccess$,
  setNewThreadCloudBrowserEnabled$,
  setNewThreadComputerUseHostId$,
  setNewThreadGenerationTemplate$,
} from "./zero-chat-composer.ts";

const WORKFLOW_PROMPT_DRAFT_TARGET = "composer:new-thread";

const displayName$ = computed(async (get): Promise<string> => {
  return (await get(currentChatAgentDisplayName$)) ?? "";
});
const autoFocus$ = computed((): Promise<boolean> => {
  return Promise.resolve(true);
});
const actionsLoading$ = computed((): Promise<boolean> => {
  return Promise.resolve(false);
});
const idle$ = computed((): Promise<boolean> => {
  return Promise.resolve(false);
});
const emptyPendingEvents$ = computed(
  (): Promise<readonly ComposerPendingEvent[]> => {
    return Promise.resolve([]);
  },
);
const noActiveGoal$ = computed((): Promise<string | null> => {
  return Promise.resolve(null);
});

const draftChanged$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(queueCurrentAgentDraftSync$, signal);
  },
);

const setModelSelection$ = command(
  async (
    { set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    set(setChatPageModelSelection$, selection);
    const selectedModel = selection?.selectedModel;
    if (isSupportedRunModel(selectedModel)) {
      await set(updateUserModelPreference$, { selectedModel }, signal);
    }
    await set(updateCodexFastModeDefaultForSelection$, selection, signal);
  },
);

const computerUseHostId$ = computed((get): string | null => {
  const selection = get(newThreadComputerAccess$);
  return selection.kind === "computerUse" ? selection.hostId : null;
});
const cloudBrowserEnabled$ = computed((get): boolean => {
  return get(newThreadComputerAccess$).kind === "cloudBrowser";
});
const setComputerUseHostId$ = command(
  ({ set }, hostId: string | null, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(setNewThreadComputerUseHostId$, hostId);
    return Promise.resolve();
  },
);
const setCloudBrowserEnabled$ = command(
  ({ set }, enabled: boolean, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(setNewThreadCloudBrowserEnabled$, enabled);
    return Promise.resolve();
  },
);

const submitMessage$ = command(
  async (
    { get: read, set },
    action: "send" | "queue",
    submission: ComposerSubmission,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (action !== "send") {
      throw new Error("The new-thread composer does not support queueing");
    }
    const agentId = await read(currentChatAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      return false;
    }
    const access = read(newThreadComputerAccess$);
    const hosts = await read(computerUseHosts$);
    signal.throwIfAborted();
    const hostId =
      access.kind === "computerUse"
        ? selectedComputerUseHostId(hosts, access.hostId)
        : null;
    const sent = await set(
      sendNewThread$,
      {
        agentId,
        prompt: submission.prompt,
        generationTemplate: submission.generationTemplate,
        editorDocument: submission.editorDocument,
        ...(access.kind === "computerUse" ? { computerUseHostId: hostId } : {}),
        ...(access.kind === "cloudBrowser"
          ? { cloudBrowserEnabled: true }
          : {}),
      },
      signal,
    );
    if (sent) {
      set(setNewThreadGenerationTemplate$, undefined);
      set(resetNewThreadComputerAccess$);
      set(resetChatPageModelSelection$);
    }
    return sent;
  },
);

const unsupportedAction$ = command(
  (_context, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.reject(
      new Error("This composer action is unavailable for a new thread"),
    );
  },
);
const unsupportedEventAction$ = command(
  (_context, _eventId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.reject(
      new Error("This composer event action is unavailable for a new thread"),
    );
  },
);
const openActiveGoal$ = command((): void => {
  throw new Error("Active goals are unavailable for a new thread");
});

function createAgentWorkflowPromptSignals(draft: DraftSignals) {
  const replaceWorkflowPromptOpen$ = computed((read): boolean => {
    return (
      read(replaceWorkflowPromptDraftTarget$) === WORKFLOW_PROMPT_DRAFT_TARGET
    );
  });
  const applyWorkflowPrompt$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(draft.setInput$, CREATE_WORKFLOW_WITH_CHAT_PROMPT);
      await set(queueCurrentAgentDraftSync$, signal);
    },
  );
  const createWorkflowPrompt$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      if (set(draft.readInput$).trim().length > 0) {
        set(setReplaceWorkflowPromptDraftTarget$, WORKFLOW_PROMPT_DRAFT_TARGET);
        return;
      }
      await set(applyWorkflowPrompt$, signal);
    },
  );
  const confirmReplaceWorkflowPrompt$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(setReplaceWorkflowPromptDraftTarget$, null);
      await set(applyWorkflowPrompt$, signal);
    },
  );
  const setReplaceWorkflowPromptOpen$ = command(
    ({ set }, open: boolean): void => {
      set(
        setReplaceWorkflowPromptDraftTarget$,
        open ? WORKFLOW_PROMPT_DRAFT_TARGET : null,
      );
    },
  );

  return {
    createWorkflowPrompt$,
    replaceWorkflowPromptOpen$,
    confirmReplaceWorkflowPrompt$,
    setReplaceWorkflowPromptOpen$,
  };
}

export const agentChatComposerSignals$ = computed((get) => {
  const draft = get(talkDraft$);
  const workflowComposer = get(chatPageWorkflowComposer$);
  const workflowPrompt = createAgentWorkflowPromptSignals(draft);

  return createComposerSignals({
    composerId: "agent:new-thread",
    threadId: null,
    workflowComposer,
    draft,
    generationTemplate$: newThreadGenerationTemplate$,
    setGenerationTemplate$: setNewThreadGenerationTemplate$,
    connectors: chatPageComposerConnectors,
    displayName$,
    autoFocus$,
    mobileSingleLine: false,
    actionsLoading$,
    sending$: idle$,
    queueWhileSending$: idle$,
    draftChanged$,
    ...createComposerFileInputSignals(),
    modelSelection$: chatPageModelSelection$,
    selectedModelOauthAvailable$: chatPageSelectedModelOauthAvailable$,
    setModelSelection$,
    configureSelectedModel$: configureChatPageSelectedModel$,
    computerUseHostId$,
    cloudBrowserEnabled$,
    setComputerUseHostId$,
    setCloudBrowserEnabled$,
    submitMessage$,
    cancelRun$: unsupportedAction$,
    pendingEvents$: emptyPendingEvents$,
    cancellationRecoveryPending$: idle$,
    removeQueuedMessage$: unsupportedEventAction$,
    removeWorkflowEvent$: unsupportedEventAction$,
    activeGoalObjective$: noActiveGoal$,
    cancelActiveGoal$: unsupportedAction$,
    openActiveGoal$,
    ...workflowPrompt,
  });
});
