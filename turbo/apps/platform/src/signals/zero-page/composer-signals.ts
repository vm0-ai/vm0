import type {
  GenerationTemplateRequest,
  PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import { getModelImageInputSupport } from "@vm0/api-contracts/contracts/model-providers";
import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef, withCleanup } from "../utils.ts";
import { isVisualAttachment } from "../chat-page/resolve-draft-attachments.ts";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import type { DraftSignals, ZeroChatAttachment } from "./chat-draft.ts";
import type {
  WorkflowComposerSignals,
  WorkflowComposerSubmissionSnapshot,
} from "./tiptap-workflow-composer.ts";
import {
  createComposerConnectorSignals,
  type ComposerConnectorAuthorizationState,
  type ComposerConnectorAuthorizationTarget,
  type ComposerConnectorUiState,
} from "./zero-connectors.ts";
import {
  createComposerUiSignals,
  type ComposerUiSignals,
} from "./zero-chat-composer.ts";

type FlatWorkflowComposerSignals = Omit<
  WorkflowComposerSignals,
  "agentId$" | "feedback" | "readInputForSubmission$"
>;

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

export interface ComposerSignals
  extends FlatWorkflowComposerSignals, ComposerUiSignals {
  readonly agent$: Computed<Promise<ZeroAgentResponse>>;
  readonly mobileSingleLine: boolean;
  readonly sending$: Computed<Promise<boolean>>;

  readonly connectorAuthorization$: Computed<
    Promise<ComposerConnectorAuthorizationState>
  >;
  readonly setConnectorAuthorization$: Command<
    Promise<void>,
    [ComposerConnectorAuthorizationTarget, boolean, AbortSignal]
  >;
  readonly connectorUiState$: Computed<ComposerConnectorUiState>;
  readonly updateConnectorUiState$: Command<
    void,
    [Partial<ComposerConnectorUiState>]
  >;
  readonly connectorPermissionMetadata$: Computed<
    Promise<PlatformConnectorPermissionMetadata | null>
  >;
  readonly connectorPermissionGrants$: Computed<
    Promise<readonly PlatformUserPermissionGrant[]>
  >;

  readonly setDraftInput$: Command<void, [string]>;
  readonly generationTemplate$: Computed<GenerationTemplateRequest | undefined>;
  readonly setGenerationTemplate$: Command<
    void,
    [GenerationTemplateRequest | undefined]
  >;
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

  readonly modelSelection$: Computed<Promise<ModelProviderSelection | null>>;
  readonly selectedModelOauthAvailable$: Computed<Promise<boolean>>;
  readonly setModelSelection$: Command<
    Promise<void>,
    [ModelProviderSelection | null, AbortSignal]
  >;
  readonly configureSelectedModel$: Command<Promise<void>, [AbortSignal]>;

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

  readonly primaryAction$: Computed<Promise<ComposerPrimaryAction>>;
  readonly submitCurrentInput$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, AbortSignal]
  >;
  readonly activatePrimaryAction$: Command<
    Promise<boolean>,
    [ComposerPrimaryAction, AbortSignal]
  >;
  readonly pendingEvents$: Computed<Promise<readonly ComposerPendingEvent[]>>;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
  readonly removeQueuedMessage$: Command<Promise<void>, [string, AbortSignal]>;
  readonly removeWorkflowEvent$: Command<Promise<void>, [string, AbortSignal]>;
  readonly activeGoalObjective$: Computed<Promise<string | null>>;
  readonly cancelActiveGoal$: Command<Promise<void>, [AbortSignal]>;
  readonly openActiveGoal$: Command<void, []>;

  readonly createWorkflowPrompt$: Command<Promise<void>, [AbortSignal]>;
  readonly replaceWorkflowPromptOpen$: Computed<boolean>;
  readonly confirmReplaceWorkflowPrompt$: Command<Promise<void>, [AbortSignal]>;
  readonly setReplaceWorkflowPromptOpen$: Command<void, [boolean]>;
}

interface CreateComposerSignalsOptions {
  readonly agent$: ComposerSignals["agent$"];
  readonly workflowComposer: WorkflowComposerSignals;
  readonly draft: DraftSignals;
  readonly generationTemplate$?: ComposerSignals["generationTemplate$"];
  readonly setGenerationTemplate$?: ComposerSignals["setGenerationTemplate$"];
  readonly mobileSingleLine: boolean;
  readonly actionsLoading$: Computed<Promise<boolean>>;
  readonly sending$: ComposerSignals["sending$"];
  readonly queueWhileSending$: Computed<Promise<boolean>>;
  readonly draftChanged$: ComposerSignals["draftChanged$"];
  readonly composerFileInput$: ComposerSignals["composerFileInput$"];
  readonly setComposerFileInput$: ComposerSignals["setComposerFileInput$"];
  readonly modelSelection$: ComposerSignals["modelSelection$"];
  readonly selectedModelOauthAvailable$: ComposerSignals["selectedModelOauthAvailable$"];
  readonly setModelSelection$: ComposerSignals["setModelSelection$"];
  readonly configureSelectedModel$: ComposerSignals["configureSelectedModel$"];
  readonly computerUseHostId$: ComposerSignals["computerUseHostId$"];
  readonly cloudBrowserEnabled$: ComposerSignals["cloudBrowserEnabled$"];
  readonly setComputerUseHostId$: ComposerSignals["setComputerUseHostId$"];
  readonly setCloudBrowserEnabled$: ComposerSignals["setCloudBrowserEnabled$"];
  readonly submitMessage$: Command<
    Promise<boolean>,
    [ComposerSubmissionAction, ComposerSubmission, AbortSignal]
  >;
  readonly cancelRun$: Command<Promise<void>, [AbortSignal]>;
  readonly pendingEvents$: ComposerSignals["pendingEvents$"];
  readonly cancellationRecoveryPending$: ComposerSignals["cancellationRecoveryPending$"];
  readonly removeQueuedMessage$: ComposerSignals["removeQueuedMessage$"];
  readonly removeWorkflowEvent$: ComposerSignals["removeWorkflowEvent$"];
  readonly activeGoalObjective$: ComposerSignals["activeGoalObjective$"];
  readonly cancelActiveGoal$: ComposerSignals["cancelActiveGoal$"];
  readonly openActiveGoal$: ComposerSignals["openActiveGoal$"];
  readonly createWorkflowPrompt$: ComposerSignals["createWorkflowPrompt$"];
  readonly replaceWorkflowPromptOpen$: ComposerSignals["replaceWorkflowPromptOpen$"];
  readonly confirmReplaceWorkflowPrompt$: ComposerSignals["confirmReplaceWorkflowPrompt$"];
  readonly setReplaceWorkflowPromptOpen$: ComposerSignals["setReplaceWorkflowPromptOpen$"];
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

function flatWorkflowComposerSignals(
  composer: WorkflowComposerSignals,
): FlatWorkflowComposerSignals {
  return {
    editor: composer.editor,
    templatePreview: composer.templatePreview,
    setContainerRef$: composer.setContainerRef$,
    focus$: composer.focus$,
    hasInput$: composer.hasInput$,
    hasTemplateAttachment$: composer.hasTemplateAttachment$,
    activeSlashRange$: composer.activeSlashRange$,
    activeChatThreadSuggestionRange$: composer.activeChatThreadSuggestionRange$,
    chatThreadSuggestions$: composer.chatThreadSuggestions$,
    workflows$: composer.workflows$,
    reloadWorkflows$: composer.reloadWorkflows$,
    selectedSuggestionIndex$: composer.selectedSuggestionIndex$,
    setSelectedSuggestionIndex$: composer.setSelectedSuggestionIndex$,
    closeSuggestionMenu$: composer.closeSuggestionMenu$,
    insertWorkflow$: composer.insertWorkflow$,
    insertAgent$: composer.insertAgent$,
    insertChatThread$: composer.insertChatThread$,
    insertPromptMarkdown$: composer.insertPromptMarkdown$,
    insertUserMessage$: composer.insertUserMessage$,
    insertTemplate$: composer.insertTemplate$,
    readSelectedTemplate$: composer.readSelectedTemplate$,
    prepareTemplateInsertion$: composer.prepareTemplateInsertion$,
    insertText$: composer.insertText$,
    appendText$: composer.appendText$,
    selectOrAppendText$: composer.selectOrAppendText$,
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
  ComposerSignals,
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

  return {
    ...flatWorkflowComposerSignals(options.workflowComposer),
    ...createComposerConnectorSignals(options.agent$),
    ...createComputerUseUiSignals(),
    ...createComposerUiSignals(),
    ...submission,
    agent$: options.agent$,
    mobileSingleLine: options.mobileSingleLine,
    sending$: options.sending$,
    setDraftInput$: draft.setInput$,
    generationTemplate$:
      options.generationTemplate$ ?? draft.generationTemplate$,
    setGenerationTemplate$:
      options.setGenerationTemplate$ ?? draft.setGenerationTemplate$,
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
    modelSelection$: options.modelSelection$,
    selectedModelOauthAvailable$: options.selectedModelOauthAvailable$,
    setModelSelection$: options.setModelSelection$,
    configureSelectedModel$: options.configureSelectedModel$,
    computerUseHostId$: options.computerUseHostId$,
    cloudBrowserEnabled$: options.cloudBrowserEnabled$,
    setComputerUseHostId$: options.setComputerUseHostId$,
    setCloudBrowserEnabled$: options.setCloudBrowserEnabled$,
    pendingEvents$: options.pendingEvents$,
    cancellationRecoveryPending$: options.cancellationRecoveryPending$,
    removeQueuedMessage$: options.removeQueuedMessage$,
    removeWorkflowEvent$: options.removeWorkflowEvent$,
    activeGoalObjective$: options.activeGoalObjective$,
    cancelActiveGoal$: options.cancelActiveGoal$,
    openActiveGoal$: options.openActiveGoal$,
    createWorkflowPrompt$: options.createWorkflowPrompt$,
    replaceWorkflowPromptOpen$: options.replaceWorkflowPromptOpen$,
    confirmReplaceWorkflowPrompt$: options.confirmReplaceWorkflowPrompt$,
    setReplaceWorkflowPromptOpen$: options.setReplaceWorkflowPromptOpen$,
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
