import type {
  GenerationTemplateRequest,
  PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import { getModelImageInputSupport } from "@vm0/api-contracts/contracts/model-providers";
import { foldActiveChatGoalObjective } from "@vm0/api-contracts/contracts/chat-events";
import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef, withCleanup } from "../utils.ts";
import { isVisualAttachment } from "../chat-page/resolve-draft-attachments.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import type { DraftSignals, ZeroChatAttachment } from "./chat-draft.ts";
import type { ChatEvent } from "../chat-page/chat-event-types.ts";
import {
  deriveRunIndicatorStateFromChatEvents,
  groupSemanticChatEvents,
  isUsageEvent,
  lastAssistantCancelledFromGroups,
  queuedEventsFromSemanticEvents,
  semanticChatEventsFromChatEvents,
} from "../chat-page/chat-event-state.ts";
import { messageDocumentToDisplayText } from "./user-message-document-codec.ts";
import {
  createWorkflowComposerSignals,
  type WorkflowComposerSignals,
  type WorkflowComposerSubmissionSnapshot,
} from "./tiptap-workflow-composer.ts";
import {
  createComposerConnectorSignals,
  type ComposerConnectorSignals,
} from "./zero-connectors.ts";
import {
  createComposerUiSignals,
  type ComposerUiSignalGroups,
} from "./zero-chat-composer.ts";
import {
  CREATE_WORKFLOW_WITH_CHAT_PROMPT,
  replaceWorkflowPromptDraftTarget$,
  setReplaceWorkflowPromptDraftTarget$,
} from "../chat-page/workflow-prompt-action.ts";

type ComposerEditorSignals = Pick<
  WorkflowComposerSignals,
  | "editor"
  | "setContainerRef$"
  | "focus$"
  | "hasInput$"
  | "insertPromptMarkdown$"
  | "insertUserMessage$"
  | "insertText$"
  | "appendText$"
  | "selectOrAppendText$"
> & {
  readonly singleLineOnMobile: boolean;
};

type ComposerWorkflowEditorSignals = Pick<
  WorkflowComposerSignals,
  "workflows$" | "reloadWorkflows$" | "insertWorkflow$"
>;

type ComposerSuggestionSignals = Pick<
  WorkflowComposerSignals,
  | "activeSlashRange$"
  | "activeChatThreadSuggestionRange$"
  | "chatThreadSuggestions$"
  | "selectedSuggestionIndex$"
  | "setSelectedSuggestionIndex$"
  | "closeSuggestionMenu$"
  | "insertAgent$"
  | "insertChatThread$"
>;

type ComposerTemplateEditorSignals = Pick<
  WorkflowComposerSignals,
  | "templatePreview"
  | "hasTemplateAttachment$"
  | "insertTemplate$"
  | "readSelectedTemplate$"
  | "prepareTemplateInsertion$"
  | "setTemplateAttachmentLifecycleRef$"
>;

type ComposerDraftUiSignals = ComposerUiSignalGroups["draft"];
type ComposerModelUiSignals = ComposerUiSignalGroups["model"];
type ComposerTemplateUiSignals = ComposerUiSignalGroups["template"];

export interface ComposerSubmission {
  readonly prompt: string;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly editorDocument: WorkflowComposerSubmissionSnapshot["editorDocument"];
}

export type ComposerSubmissionAction = "send" | "queue";

export type ComposerPrimaryAction =
  | ComposerSubmissionAction
  | "stop"
  | "disabled";

export type ComposerPendingEvent =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "automation";
      readonly id: string;
      readonly workflowName: string;
      readonly automationBrief: string | undefined;
    };

interface ComposerWorkflowSignals extends ComposerWorkflowEditorSignals {
  readonly createWorkflowPrompt$: Command<Promise<void>, [AbortSignal]>;
  readonly replaceWorkflowPromptOpen$: Computed<boolean>;
  readonly confirmReplaceWorkflowPrompt$: Command<Promise<void>, [AbortSignal]>;
  readonly setReplaceWorkflowPromptOpen$: Command<void, [boolean]>;
}

interface ComposerDraftSignals extends ComposerDraftUiSignals {
  readonly setDraftInput$: Command<void, [string]>;
  readonly attachments$: Computed<ZeroChatAttachment[]>;
  readonly attachmentUploadsReady$: Computed<boolean | Promise<boolean>>;
  readonly uploadAttachment$: Command<Promise<void>, [File, AbortSignal]>;
  readonly restoreAttachments$: Command<void, [PersistedAttachment[]]>;
  readonly removeAttachment$: Command<void, [ZeroChatAttachment]>;
  readonly dragOver$: Computed<boolean>;
  readonly setDragOver$: Command<void, [boolean]>;
  readonly composerFileInput$: Computed<HTMLElement | null>;
  readonly setComposerFileInput$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly draftChanged$: Command<Promise<void>, [AbortSignal]>;
}

interface ComposerModelSignals extends ComposerModelUiSignals {
  readonly modelSelection$: Computed<Promise<ModelProviderSelection | null>>;
  readonly selectedModelOauthAvailable$: Computed<Promise<boolean>>;
  readonly setModelSelection$: Command<
    Promise<void>,
    [ModelProviderSelection | null, AbortSignal]
  >;
  readonly configureSelectedModel$: Command<Promise<void>, [AbortSignal]>;
}

interface ComposerComputerSignals {
  readonly computerUseHostId$: Computed<string | null>;
  readonly cloudBrowserEnabled$: Computed<boolean>;
  readonly setComputerUseHostId$: Command<
    Promise<void>,
    [string | null, AbortSignal]
  >;
  readonly setCloudBrowserEnabled$: Command<
    Promise<void>,
    [boolean, AbortSignal]
  >;
  readonly computerUseDownloadDialogOpen$: Computed<boolean>;
  readonly setComputerUseDownloadDialogOpen$: Command<void, [boolean]>;
}

interface ComposerSubmissionSignals {
  readonly sending$: Computed<Promise<boolean>>;
  readonly primaryAction$: Computed<Promise<ComposerPrimaryAction>>;
  readonly submitCurrentInput$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, AbortSignal]
  >;
  readonly activatePrimaryAction$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, AbortSignal]
  >;
}

interface ComposerQueueSignals {
  readonly pendingEvents$: Computed<Promise<readonly ComposerPendingEvent[]>>;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
  readonly removeQueuedMessage$: Command<Promise<void>, [string, AbortSignal]>;
  readonly removeWorkflowEvent$: Command<Promise<void>, [string, AbortSignal]>;
}

interface ComposerGoalSignals {
  readonly activeGoalObjective$: Computed<Promise<string | null>>;
  readonly cancelActiveGoal$: Command<Promise<void>, [AbortSignal]>;
  readonly openActiveGoal$: Command<void, []>;
}

interface ComposerTemplateSignals
  extends ComposerTemplateEditorSignals, ComposerTemplateUiSignals {
  readonly generationTemplate$: Computed<GenerationTemplateRequest | undefined>;
  readonly setGenerationTemplate$: Command<
    void,
    [GenerationTemplateRequest | undefined]
  >;
}

export interface ComposerSignals {
  readonly agent$: Computed<Promise<ZeroAgentResponse>>;
  readonly editor: ComposerEditorSignals;
  readonly feedback: WorkflowComposerSignals["feedback"];
  readonly workflow: ComposerWorkflowSignals;
  readonly suggestion: ComposerSuggestionSignals;
  readonly connector: ComposerConnectorSignals;
  readonly draft: ComposerDraftSignals;
  readonly model: ComposerModelSignals;
  readonly computer: ComposerComputerSignals;
  readonly submission: ComposerSubmissionSignals;
  readonly queue: ComposerQueueSignals;
  readonly goal: ComposerGoalSignals;
  readonly template: ComposerTemplateSignals;
}

interface CreateComposerSignalsOptions {
  readonly agent$: ComposerSignals["agent$"];
  readonly draft: DraftSignals;
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly threadId?: string;
  readonly inlineTemplatesEnabled: boolean;
  readonly generationTemplate$?: ComposerTemplateSignals["generationTemplate$"];
  readonly setGenerationTemplate$?: ComposerTemplateSignals["setGenerationTemplate$"];
  readonly singleLineOnMobile: boolean;
  readonly draftChanged$: ComposerDraftSignals["draftChanged$"];
  readonly modelSelection$: ComposerModelSignals["modelSelection$"];
  readonly selectedModelOauthAvailable$: ComposerModelSignals["selectedModelOauthAvailable$"];
  readonly setModelSelection$: ComposerModelSignals["setModelSelection$"];
  readonly configureSelectedModel$: ComposerModelSignals["configureSelectedModel$"];
  readonly computerUseHostId$: ComposerComputerSignals["computerUseHostId$"];
  readonly cloudBrowserEnabled$: ComposerComputerSignals["cloudBrowserEnabled$"];
  readonly setComputerUseHostId$: ComposerComputerSignals["setComputerUseHostId$"];
  readonly setCloudBrowserEnabled$: ComposerComputerSignals["setCloudBrowserEnabled$"];
  readonly submitMessage$: Command<
    Promise<boolean>,
    [ComposerSubmissionAction, ComposerSubmission, AbortSignal]
  >;
  readonly cancelRun$: Command<Promise<void>, [AbortSignal]>;
  readonly cancellationRecoveryPending$: ComposerQueueSignals["cancellationRecoveryPending$"];
  readonly removeQueuedMessage$: ComposerQueueSignals["removeQueuedMessage$"];
  readonly removeWorkflowEvent$: ComposerQueueSignals["removeWorkflowEvent$"];
  readonly cancelActiveGoal$: ComposerGoalSignals["cancelActiveGoal$"];
  readonly openActiveGoal$: ComposerGoalSignals["openActiveGoal$"];
}

function createComposerFileInputSignals() {
  const internal$ = state<HTMLElement | null>(null);
  const composerFileInput$ = computed((get) => {
    return get(internal$);
  });
  const setComposerFileInput$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(internal$, null);
      });
      set(internal$, element);
    }),
  );
  return { composerFileInput$, setComposerFileInput$ };
}

function composerEditorSignals(
  composer: WorkflowComposerSignals,
  singleLineOnMobile: boolean,
): ComposerEditorSignals {
  return {
    singleLineOnMobile,
    editor: composer.editor,
    setContainerRef$: composer.setContainerRef$,
    focus$: composer.focus$,
    hasInput$: composer.hasInput$,
    insertPromptMarkdown$: composer.insertPromptMarkdown$,
    insertUserMessage$: composer.insertUserMessage$,
    insertText$: composer.insertText$,
    appendText$: composer.appendText$,
    selectOrAppendText$: composer.selectOrAppendText$,
  };
}

function composerWorkflowSignals(
  composer: WorkflowComposerSignals,
): ComposerWorkflowEditorSignals {
  return {
    workflows$: composer.workflows$,
    reloadWorkflows$: composer.reloadWorkflows$,
    insertWorkflow$: composer.insertWorkflow$,
  };
}

function composerSuggestionSignals(
  composer: WorkflowComposerSignals,
): ComposerSuggestionSignals {
  return {
    activeSlashRange$: composer.activeSlashRange$,
    activeChatThreadSuggestionRange$: composer.activeChatThreadSuggestionRange$,
    chatThreadSuggestions$: composer.chatThreadSuggestions$,
    selectedSuggestionIndex$: composer.selectedSuggestionIndex$,
    setSelectedSuggestionIndex$: composer.setSelectedSuggestionIndex$,
    closeSuggestionMenu$: composer.closeSuggestionMenu$,
    insertAgent$: composer.insertAgent$,
    insertChatThread$: composer.insertChatThread$,
  };
}

function composerTemplateSignals(
  composer: WorkflowComposerSignals,
): ComposerTemplateEditorSignals {
  return {
    templatePreview: composer.templatePreview,
    hasTemplateAttachment$: composer.hasTemplateAttachment$,
    insertTemplate$: composer.insertTemplate$,
    readSelectedTemplate$: composer.readSelectedTemplate$,
    prepareTemplateInsertion$: composer.prepareTemplateInsertion$,
    setTemplateAttachmentLifecycleRef$:
      composer.setTemplateAttachmentLifecycleRef$,
  };
}

function hasVisibleAttachment(
  selection: ModelProviderSelection | null,
  attachments: readonly ZeroChatAttachment[],
): boolean {
  if (getModelImageInputSupport(selection?.selectedModel) !== "unsupported") {
    return attachments.length > 0;
  }
  return attachments.some((attachment) => {
    return !isVisualAttachment(attachment);
  });
}

function createComputerUseUiSignals(): Pick<
  ComposerComputerSignals,
  "computerUseDownloadDialogOpen$" | "setComputerUseDownloadDialogOpen$"
> {
  const internalDownloadDialogOpen$ = state(false);
  const computerUseDownloadDialogOpen$ = computed((get): boolean => {
    return get(internalDownloadDialogOpen$);
  });
  const setComputerUseDownloadDialogOpen$ = command(
    ({ set }, open: boolean): void => {
      set(internalDownloadDialogOpen$, open);
    },
  );
  return {
    computerUseDownloadDialogOpen$,
    setComputerUseDownloadDialogOpen$,
  };
}

function createComposerWorkflowPromptSignals(
  options: CreateComposerSignalsOptions,
  workflowComposer: WorkflowComposerSignals,
): Pick<
  ComposerWorkflowSignals,
  | "createWorkflowPrompt$"
  | "replaceWorkflowPromptOpen$"
  | "confirmReplaceWorkflowPrompt$"
  | "setReplaceWorkflowPromptOpen$"
> {
  const draftTarget = `composer:${options.threadId ?? "new-thread"}`;
  const replaceWorkflowPromptOpen$ = computed((get): boolean => {
    return get(replaceWorkflowPromptDraftTarget$) === draftTarget;
  });
  const applyWorkflowPrompt$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      if (options.threadId !== undefined) {
        set(options.draft.clear$);
      }
      set(options.draft.setInput$, CREATE_WORKFLOW_WITH_CHAT_PROMPT);
      await set(options.draftChanged$, signal);
      if (options.threadId !== undefined) {
        set(workflowComposer.focus$);
      }
    },
  );
  const createWorkflowPrompt$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const hasDraft =
        set(options.draft.readInput$).trim().length > 0 ||
        (options.threadId !== undefined &&
          get(options.draft.attachments$).length > 0);
      if (hasDraft) {
        set(setReplaceWorkflowPromptDraftTarget$, draftTarget);
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
      set(setReplaceWorkflowPromptDraftTarget$, open ? draftTarget : null);
    },
  );
  return {
    createWorkflowPrompt$,
    replaceWorkflowPromptOpen$,
    confirmReplaceWorkflowPrompt$,
    setReplaceWorkflowPromptOpen$,
  };
}

function createRemoveQueuedMessage(
  removeQueuedMessage$: CreateComposerSignalsOptions["removeQueuedMessage$"],
  workflowComposer: WorkflowComposerSignals,
): ComposerQueueSignals["removeQueuedMessage$"] {
  return command(
    async ({ set }, eventId: string, signal: AbortSignal): Promise<void> => {
      await set(removeQueuedMessage$, eventId, signal);
      set(workflowComposer.focus$);
    },
  );
}

export function createComposerSignals(
  options: CreateComposerSignalsOptions,
): ComposerSignals {
  const eventSignals = createComposerChatEventSignals(options.chatEvents$);
  const draft = options.draft;
  const agentId$ = computed(async (get): Promise<string | null> => {
    return (await get(options.agent$)).agentId;
  });
  const autoFocus$ = computed(async (get): Promise<boolean> => {
    return !(await get(eventSignals.hasEvents$));
  });
  const workflowComposer = createWorkflowComposerSignals(
    draft,
    options.threadId,
    agentId$,
    options.inlineTemplatesEnabled,
    {
      autoFocus: autoFocus$,
      singleLineOnMobile: options.singleLineOnMobile,
    },
  );
  const submission = createComposerSubmissionSignals(
    options,
    eventSignals,
    workflowComposer,
  );
  const fileInput = createComposerFileInputSignals();
  const workflowPrompt = createComposerWorkflowPromptSignals(
    options,
    workflowComposer,
  );
  const ui = createComposerUiSignals();

  return {
    agent$: options.agent$,
    editor: composerEditorSignals(workflowComposer, options.singleLineOnMobile),
    feedback: workflowComposer.feedback,
    workflow: {
      ...composerWorkflowSignals(workflowComposer),
      ...workflowPrompt,
    },
    suggestion: composerSuggestionSignals(workflowComposer),
    connector: createComposerConnectorSignals(options.agent$),
    draft: {
      ...ui.draft,
      setDraftInput$: draft.setInput$,
      attachments$: draft.attachments$,
      attachmentUploadsReady$: draft.attachmentUploadsReady$,
      uploadAttachment$: draft.uploadAttachment$,
      restoreAttachments$: draft.restoreAttachments$,
      removeAttachment$: draft.removeAttachment$,
      dragOver$: draft.dragOver$,
      setDragOver$: draft.setDragOver$,
      ...fileInput,
      draftChanged$: options.draftChanged$,
    },
    model: {
      ...ui.model,
      modelSelection$: options.modelSelection$,
      selectedModelOauthAvailable$: options.selectedModelOauthAvailable$,
      setModelSelection$: options.setModelSelection$,
      configureSelectedModel$: options.configureSelectedModel$,
    },
    computer: {
      ...createComputerUseUiSignals(),
      computerUseHostId$: options.computerUseHostId$,
      cloudBrowserEnabled$: options.cloudBrowserEnabled$,
      setComputerUseHostId$: options.setComputerUseHostId$,
      setCloudBrowserEnabled$: options.setCloudBrowserEnabled$,
    },
    submission: {
      ...submission,
      sending$: eventSignals.sending$,
    },
    queue: {
      pendingEvents$: eventSignals.pendingEvents$,
      cancellationRecoveryPending$: options.cancellationRecoveryPending$,
      removeQueuedMessage$: createRemoveQueuedMessage(
        options.removeQueuedMessage$,
        workflowComposer,
      ),
      removeWorkflowEvent$: options.removeWorkflowEvent$,
    },
    goal: {
      activeGoalObjective$: eventSignals.activeGoalObjective$,
      cancelActiveGoal$: options.cancelActiveGoal$,
      openActiveGoal$: options.openActiveGoal$,
    },
    template: {
      ...composerTemplateSignals(workflowComposer),
      ...ui.template,
      generationTemplate$:
        options.generationTemplate$ ?? draft.generationTemplate$,
      setGenerationTemplate$:
        options.setGenerationTemplate$ ?? draft.setGenerationTemplate$,
    },
  };
}

function createComposerChatEventSignals(chatEvents$: Computed<ChatEvent[]>) {
  const semanticEvents$ = computed((get) => {
    return semanticChatEventsFromChatEvents(get(chatEvents$));
  });
  const semanticGroups$ = computed((get) => {
    return groupSemanticChatEvents(get(semanticEvents$));
  });
  const hasEvents$ = computed((get): Promise<boolean> => {
    return Promise.resolve(
      get(semanticEvents$).some((entry) => {
        return !isUsageEvent(entry.event);
      }),
    );
  });
  const runIndicatorState$ = computed((get) => {
    return deriveRunIndicatorStateFromChatEvents(get(chatEvents$));
  });
  const sending$ = computed((get): Promise<boolean> => {
    const running = get(runIndicatorState$) !== null;
    const lastAssistantCancelled = lastAssistantCancelledFromGroups(
      get(semanticGroups$),
    );
    return Promise.resolve(running && !lastAssistantCancelled);
  });
  const actionsLoading$ = computed(async (get): Promise<boolean> => {
    await get(hasEvents$);
    return false;
  });
  const pendingEvents$ = computed(
    (get): Promise<readonly ComposerPendingEvent[]> => {
      return Promise.resolve(
        queuedEventsFromSemanticEvents(get(semanticEvents$)).map((event) => {
          if (event.eventType === "input.automation") {
            const automationPart = event.userMessage?.parts.find((part) => {
              return part.type === "automation";
            });
            if (!automationPart || automationPart.type !== "automation") {
              return {
                kind: "message" as const,
                id: event.id,
                text: "",
              };
            }
            return {
              kind: "automation" as const,
              id: event.id,
              workflowName: automationPart.workflowName,
              automationBrief: automationPart.automationBrief,
            };
          }
          return {
            kind: "message" as const,
            id: event.id,
            text: (
              messageDocumentToDisplayText(event.userMessage) ?? ""
            ).trim(),
          };
        }),
      );
    },
  );
  const activeGoalObjective$ = computed((get): Promise<string | null> => {
    return Promise.resolve(foldActiveChatGoalObjective(get(chatEvents$)));
  });
  return {
    actionsLoading$,
    sending$,
    pendingEvents$,
    activeGoalObjective$,
    hasEvents$,
  };
}

function createComposerSubmissionSignals(
  options: CreateComposerSignalsOptions,
  eventSignals: ReturnType<typeof createComposerChatEventSignals>,
  workflowComposer: WorkflowComposerSignals,
) {
  const draft = options.draft;
  const internalSubmissionPending$ = state(false);
  const submissionPending$ = computed((get): boolean => {
    return get(internalSubmissionPending$);
  });
  const primaryAction$ = computed(
    async (get): Promise<ComposerPrimaryAction> => {
      if (await get(eventSignals.actionsLoading$)) {
        return "disabled";
      }

      const uploadsReady = await get(draft.attachmentUploadsReady$);
      const attachments = get(draft.attachments$);
      let hasContent = get(workflowComposer.hasInput$);
      if (!hasContent && attachments.length > 0) {
        const modelSelection = await get(options.modelSelection$);
        hasContent = hasVisibleAttachment(modelSelection, attachments);
      }
      const canSend = uploadsReady && hasContent;
      const sending = await get(eventSignals.sending$);
      if (sending && !canSend) {
        return "stop";
      }
      if (get(submissionPending$)) {
        return "disabled";
      }
      if (!canSend) {
        return "disabled";
      }
      if (!sending) {
        return "send";
      }
      return "queue";
    },
  );
  const submitCurrentInput$ = command(
    async (
      { get, set },
      action: ComposerPrimaryAction,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      if (action !== "send" && action !== "queue") {
        return false;
      }
      if (get(internalSubmissionPending$)) {
        return false;
      }

      set(internalSubmissionPending$, true);
      return await withCleanup(
        (async () => {
          const submission = await set(
            workflowComposer.readInputForSubmission$,
            signal,
          );
          signal.throwIfAborted();
          const prompt = submission.prompt.trim();
          if (prompt.length === 0) {
            const attachments = get(draft.attachments$);
            if (attachments.length === 0) {
              return false;
            }
            const modelSelection = await get(options.modelSelection$);
            signal.throwIfAborted();
            if (!hasVisibleAttachment(modelSelection, attachments)) {
              return false;
            }
          }
          return await set(
            options.submitMessage$,
            action,
            {
              prompt,
              generationTemplate: get(
                options.generationTemplate$ ?? draft.generationTemplate$,
              ),
              editorDocument: submission.editorDocument,
            },
            signal,
          );
        })(),
        () => {
          set(internalSubmissionPending$, false);
        },
      );
    },
  );
  const activatePrimaryAction$ = command(
    async (
      { set },
      action: ComposerPrimaryAction,
      signal: AbortSignal,
    ): Promise<boolean> => {
      signal.throwIfAborted();
      if (action === "stop") {
        await set(options.cancelRun$, signal);
        return true;
      }
      return await set(submitCurrentInput$, action, signal);
    },
  );

  return {
    primaryAction$,
    submitCurrentInput$,
    activatePrimaryAction$,
  };
}
