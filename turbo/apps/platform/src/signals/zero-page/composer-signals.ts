import type {
  GenerationTemplateRequest,
  PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import { getModelImageInputSupport } from "@vm0/api-contracts/contracts/model-providers";
import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef, withCleanup } from "../utils.ts";
import { isVisualAttachment } from "../chat-page/resolve-draft-attachments.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import type { DraftSignals, ZeroChatAttachment } from "./chat-draft.ts";
import type {
  WorkflowComposerSignals,
  WorkflowComposerSubmissionSnapshot,
} from "./tiptap-workflow-composer.ts";
import {
  createComposerConnectorSignals,
  type ComposerConnectorSignals,
} from "./zero-connectors.ts";
import {
  createComposerUiSignals,
  type ComposerUiSignalGroups,
} from "./zero-chat-composer.ts";

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
>;

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

interface ComposerContextSignals {
  readonly agent$: Computed<Promise<ZeroAgentResponse>>;
  readonly mobileSingleLine: boolean;
}

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
  readonly context: ComposerContextSignals;
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
  readonly agent$: ComposerContextSignals["agent$"];
  readonly workflowComposer: WorkflowComposerSignals;
  readonly draft: DraftSignals;
  readonly generationTemplate$?: ComposerTemplateSignals["generationTemplate$"];
  readonly setGenerationTemplate$?: ComposerTemplateSignals["setGenerationTemplate$"];
  readonly mobileSingleLine: boolean;
  readonly actionsLoading$: Computed<Promise<boolean>>;
  readonly sending$: ComposerSubmissionSignals["sending$"];
  readonly queueWhileSending$: Computed<Promise<boolean>>;
  readonly draftChanged$: ComposerDraftSignals["draftChanged$"];
  readonly composerFileInput$: ComposerDraftSignals["composerFileInput$"];
  readonly setComposerFileInput$: ComposerDraftSignals["setComposerFileInput$"];
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
  readonly pendingEvents$: ComposerQueueSignals["pendingEvents$"];
  readonly cancellationRecoveryPending$: ComposerQueueSignals["cancellationRecoveryPending$"];
  readonly removeQueuedMessage$: ComposerQueueSignals["removeQueuedMessage$"];
  readonly removeWorkflowEvent$: ComposerQueueSignals["removeWorkflowEvent$"];
  readonly activeGoalObjective$: ComposerGoalSignals["activeGoalObjective$"];
  readonly cancelActiveGoal$: ComposerGoalSignals["cancelActiveGoal$"];
  readonly openActiveGoal$: ComposerGoalSignals["openActiveGoal$"];
  readonly createWorkflowPrompt$: ComposerWorkflowSignals["createWorkflowPrompt$"];
  readonly replaceWorkflowPromptOpen$: ComposerWorkflowSignals["replaceWorkflowPromptOpen$"];
  readonly confirmReplaceWorkflowPrompt$: ComposerWorkflowSignals["confirmReplaceWorkflowPrompt$"];
  readonly setReplaceWorkflowPromptOpen$: ComposerWorkflowSignals["setReplaceWorkflowPromptOpen$"];
}

export function createComposerFileInputSignals() {
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
): ComposerEditorSignals {
  return {
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

export function createComposerSignals(
  options: CreateComposerSignalsOptions,
): ComposerSignals {
  const submission = createComposerSubmissionSignals(options);
  const draft = options.draft;
  const ui = createComposerUiSignals();

  return {
    context: {
      agent$: options.agent$,
      mobileSingleLine: options.mobileSingleLine,
    },
    editor: composerEditorSignals(options.workflowComposer),
    feedback: options.workflowComposer.feedback,
    workflow: {
      ...composerWorkflowSignals(options.workflowComposer),
      createWorkflowPrompt$: options.createWorkflowPrompt$,
      replaceWorkflowPromptOpen$: options.replaceWorkflowPromptOpen$,
      confirmReplaceWorkflowPrompt$: options.confirmReplaceWorkflowPrompt$,
      setReplaceWorkflowPromptOpen$: options.setReplaceWorkflowPromptOpen$,
    },
    suggestion: composerSuggestionSignals(options.workflowComposer),
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
      composerFileInput$: options.composerFileInput$,
      setComposerFileInput$: options.setComposerFileInput$,
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
      sending$: options.sending$,
    },
    queue: {
      pendingEvents$: options.pendingEvents$,
      cancellationRecoveryPending$: options.cancellationRecoveryPending$,
      removeQueuedMessage$: options.removeQueuedMessage$,
      removeWorkflowEvent$: options.removeWorkflowEvent$,
    },
    goal: {
      activeGoalObjective$: options.activeGoalObjective$,
      cancelActiveGoal$: options.cancelActiveGoal$,
      openActiveGoal$: options.openActiveGoal$,
    },
    template: {
      ...composerTemplateSignals(options.workflowComposer),
      ...ui.template,
      generationTemplate$:
        options.generationTemplate$ ?? draft.generationTemplate$,
      setGenerationTemplate$:
        options.setGenerationTemplate$ ?? draft.setGenerationTemplate$,
    },
  };
}

function createComposerSubmissionSignals(
  options: CreateComposerSignalsOptions,
) {
  const draft = options.draft;
  const workflowComposer = options.workflowComposer;
  const internalSubmissionPending$ = state(false);
  const submissionPending$ = computed((get): boolean => {
    return get(internalSubmissionPending$);
  });
  const primaryAction$ = computed(
    async (get): Promise<ComposerPrimaryAction> => {
      if (await get(options.actionsLoading$)) {
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
      const sending = await get(options.sending$);
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
      return (await get(options.queueWhileSending$)) ? "queue" : "disabled";
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
