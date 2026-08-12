import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  VideoGenerationOptions,
} from "@vm0/api-contracts/contracts/chat-threads";
import { foldActiveChatGoalObjective } from "@vm0/api-contracts/contracts/chat-events";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { DEFAULT_VIDEO_MODEL } from "@vm0/core/video-model-catalog";
import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef, withCleanup } from "../utils.ts";
import {
  isVisualAttachment,
  shouldExcludeVisualAttachmentsForModel,
} from "../chat-page/resolve-draft-attachments.ts";
import {
  featureSwitch$,
  imageRecognitionAvailable$,
} from "../external/feature-switch.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import type { DraftSignals, ZeroChatAttachment } from "./chat-draft.ts";
import { createComposerFeedbackModel } from "./chat-feedback.ts";
import type { ChatEvent } from "../chat-page/chat-event-types.ts";
import {
  deriveRunIndicatorStateFromChatEvents,
  groupSemanticChatEvents,
  isUsageEvent,
  lastAssistantCancelledFromGroups,
  queuedEventsFromSemanticEvents,
  runningModelSelectionFromChatEvents,
  semanticChatEventsFromChatEvents,
  type ChatRunModelSelection,
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
import {
  draftMentionsVideo,
  latestVideoSettingsFromChatEvents,
  messageVideoTemplateContext,
} from "./video-draft-settings.ts";

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
  | "hasInlineVideoTemplate$"
  | "insertTemplate$"
  | "updateTemplateAt$"
  | "readSelectedTemplate$"
  | "prepareTemplateInsertion$"
  | "setTemplateAttachmentLifecycleRef$"
>;

type ComposerModelUiSignals = ComposerUiSignalGroups["model"];
type ComposerTemplateUiSignals = ComposerUiSignalGroups["template"];

export interface ComposerSubmission {
  readonly prompt: string;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly videoOptions: VideoGenerationOptions | undefined;
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

interface ComposerDraftSignals {
  readonly seed$: DraftSignals["seed$"];
  readonly setDraftInput$: Command<void, [string]>;
  readonly attachments$: Computed<ZeroChatAttachment[]>;
  readonly attachmentUploadsReady$: Computed<boolean>;
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
  readonly save$: Command<Promise<void>, [AbortSignal]>;
}

interface ComposerModelSignals extends ComposerModelUiSignals {
  readonly temporaryModelNoticeEnabled$: Computed<boolean>;
  readonly modelSelection$: Computed<Promise<ModelProviderSelection | null>>;
  readonly runningModelSelection$: Computed<
    Promise<ChatRunModelSelection | null>
  >;
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
  readonly removeAutomationEvent$: Command<
    Promise<void>,
    [string, AbortSignal]
  >;
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

interface ComposerVideoSignals {
  readonly intentDetected$: Computed<boolean>;
  readonly effectiveOptions$: Computed<VideoGenerationOptions | undefined>;
  readonly setOptions$: Command<void, [VideoGenerationOptions | undefined]>;
}

export interface ComposerSignals {
  readonly agentId: string;
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
  readonly video: ComposerVideoSignals;
}

interface CreateComposerSignalsOptions {
  readonly agentId: string;
  readonly draft: {
    readonly signals: DraftSignals;
    readonly save$: ComposerDraftSignals["save$"];
  };
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly threadId?: string;
  readonly singleLineOnMobile: boolean;
  readonly implicitContent?: boolean;
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
  readonly removeAutomationEvent$: ComposerQueueSignals["removeAutomationEvent$"];
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
    hasInlineVideoTemplate$: composer.hasInlineVideoTemplate$,
    insertTemplate$: composer.insertTemplate$,
    updateTemplateAt$: composer.updateTemplateAt$,
    readSelectedTemplate$: composer.readSelectedTemplate$,
    prepareTemplateInsertion$: composer.prepareTemplateInsertion$,
    setTemplateAttachmentLifecycleRef$:
      composer.setTemplateAttachmentLifecycleRef$,
  };
}

function hasVisibleAttachment(
  selection: ModelProviderSelection | null,
  attachments: readonly ZeroChatAttachment[],
  imageRecognitionEnabled: boolean,
): boolean {
  if (
    !shouldExcludeVisualAttachmentsForModel(
      selection?.selectedModel,
      imageRecognitionEnabled,
    )
  ) {
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
  const draft = options.draft.signals;
  const draftTarget = `composer:${options.threadId ?? "new-thread"}`;
  const replaceWorkflowPromptOpen$ = computed((get): boolean => {
    return get(replaceWorkflowPromptDraftTarget$) === draftTarget;
  });
  const applyWorkflowPrompt$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      if (options.threadId !== undefined) {
        set(draft.clear$);
      }
      set(draft.setInput$, CREATE_WORKFLOW_WITH_CHAT_PROMPT);
      await set(options.draft.save$, signal);
      if (options.threadId !== undefined) {
        set(workflowComposer.focus$);
      }
    },
  );
  const createWorkflowPrompt$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const hasDraft =
        set(draft.readInput$).trim().length > 0 ||
        (options.threadId !== undefined && get(draft.attachments$).length > 0);
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

function createComposerVideoSignals(
  draft: DraftSignals,
  eventSignals: ReturnType<typeof createComposerChatEventSignals>,
): ComposerVideoSignals {
  const intentDetected$ = computed((get): boolean => {
    return draftMentionsVideo(get(draft.input$));
  });
  const effectiveOptions$ = computed((get) => {
    const explicit = get(draft.videoOptions$);
    const inherited = get(eventSignals.latestVideoOptions$);
    return explicit || inherited ? { ...inherited, ...explicit } : undefined;
  });
  return {
    intentDetected$,
    effectiveOptions$,
    setOptions$: draft.setVideoOptions$,
  };
}

function videoOptionsForSubmission(args: {
  readonly intentDetected: boolean;
  readonly hasTextToVideoTemplate: boolean;
  readonly hasAvatarTemplate: boolean;
  readonly explicit: VideoGenerationOptions | undefined;
  readonly inherited: VideoGenerationOptions | undefined;
}): VideoGenerationOptions | undefined {
  if (
    (args.hasAvatarTemplate && !args.hasTextToVideoTemplate) ||
    (!args.intentDetected && !args.hasTextToVideoTemplate)
  ) {
    return undefined;
  }
  return {
    ...args.inherited,
    ...args.explicit,
    model: args.explicit?.model ?? args.inherited?.model ?? DEFAULT_VIDEO_MODEL,
  };
}

export function createComposerSignals(
  options: CreateComposerSignalsOptions,
): ComposerSignals {
  const eventSignals = createComposerChatEventSignals(options.chatEvents$);
  const draft = options.draft.signals;
  const agentId$ = computed((): string => {
    return options.agentId;
  });
  const feedback = createComposerFeedbackModel(options.threadId);
  const temporaryModelNoticeEnabled$ = computed((get): boolean => {
    return (
      options.threadId === undefined &&
      (get(featureSwitch$)[FeatureSwitchKey.NewChatDefaultModelAction] ?? false)
    );
  });
  const workflowComposer = createWorkflowComposerSignals(
    draft,
    agentId$,
    {
      autoFocus: true,
      singleLineOnMobile: options.singleLineOnMobile,
    },
    feedback,
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
  const video = createComposerVideoSignals(draft, eventSignals);

  return {
    agentId: options.agentId,
    editor: composerEditorSignals(workflowComposer, options.singleLineOnMobile),
    feedback: workflowComposer.feedback,
    workflow: {
      ...composerWorkflowSignals(workflowComposer),
      ...workflowPrompt,
    },
    suggestion: composerSuggestionSignals(workflowComposer),
    connector: createComposerConnectorSignals(options.agentId),
    draft: {
      seed$: draft.seed$,
      setDraftInput$: draft.setInput$,
      attachments$: draft.attachments$,
      attachmentUploadsReady$: draft.attachmentUploadsReady$,
      uploadAttachment$: draft.uploadAttachment$,
      restoreAttachments$: draft.restoreAttachments$,
      removeAttachment$: draft.removeAttachment$,
      dragOver$: draft.dragOver$,
      setDragOver$: draft.setDragOver$,
      ...fileInput,
      save$: options.draft.save$,
    },
    model: {
      ...ui.model,
      temporaryModelNoticeEnabled$,
      modelSelection$: options.modelSelection$,
      runningModelSelection$: eventSignals.runningModelSelection$,
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
      removeAutomationEvent$: options.removeAutomationEvent$,
    },
    goal: {
      activeGoalObjective$: eventSignals.activeGoalObjective$,
      cancelActiveGoal$: options.cancelActiveGoal$,
      openActiveGoal$: options.openActiveGoal$,
    },
    template: {
      ...composerTemplateSignals(workflowComposer),
      ...ui.template,
      generationTemplate$: draft.generationTemplate$,
      setGenerationTemplate$: draft.setGenerationTemplate$,
    },
    video,
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
  const runningModelSelection$ = computed(
    (get): Promise<ChatRunModelSelection | null> => {
      return Promise.resolve(
        runningModelSelectionFromChatEvents(get(chatEvents$)),
      );
    },
  );
  const latestVideoOptions$ = computed((get) => {
    return latestVideoSettingsFromChatEvents(get(chatEvents$));
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
    runningModelSelection$,
    latestVideoOptions$,
    pendingEvents$,
    activeGoalObjective$,
    hasEvents$,
  };
}

function createComposerPrimaryActionSignal(
  options: CreateComposerSignalsOptions,
  eventSignals: ReturnType<typeof createComposerChatEventSignals>,
  draft: DraftSignals,
  hasInput$: WorkflowComposerSignals["hasInput$"],
  submissionPending$: Computed<boolean>,
) {
  return computed(async (get): Promise<ComposerPrimaryAction> => {
    if (await get(eventSignals.actionsLoading$)) {
      return "disabled";
    }

    const uploadsReady = get(draft.attachmentUploadsReady$);
    const attachments = get(draft.attachments$);
    let hasContent = options.implicitContent === true || get(hasInput$);
    if (!hasContent && attachments.length > 0) {
      const modelSelection = await get(options.modelSelection$);
      const imageRecognitionEnabled = get(imageRecognitionAvailable$);
      hasContent = hasVisibleAttachment(
        modelSelection,
        attachments,
        imageRecognitionEnabled,
      );
    }
    const canSend = uploadsReady && hasContent;
    const sending = await get(eventSignals.sending$);
    if (sending && !canSend) {
      return "stop";
    }
    if (get(submissionPending$) || !canSend) {
      return "disabled";
    }
    return sending ? "queue" : "send";
  });
}

function createComposerSubmissionSignals(
  options: CreateComposerSignalsOptions,
  eventSignals: ReturnType<typeof createComposerChatEventSignals>,
  workflowComposer: WorkflowComposerSignals,
) {
  const draft = options.draft.signals;
  const internalSubmissionPending$ = state(false);
  const submissionPending$ = computed((get): boolean => {
    return get(internalSubmissionPending$);
  });
  const primaryAction$ = createComposerPrimaryActionSignal(
    options,
    eventSignals,
    draft,
    workflowComposer.hasInput$,
    submissionPending$,
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
      if (!get(draft.attachmentUploadsReady$)) {
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
          if (prompt.length === 0 && options.implicitContent !== true) {
            const attachments = get(draft.attachments$);
            if (attachments.length === 0) {
              return false;
            }
            const modelSelection = await get(options.modelSelection$);
            signal.throwIfAborted();
            const imageRecognitionEnabled = get(imageRecognitionAvailable$);
            if (
              !hasVisibleAttachment(
                modelSelection,
                attachments,
                imageRecognitionEnabled,
              )
            ) {
              return false;
            }
          }
          if (!get(draft.attachmentUploadsReady$)) {
            return false;
          }
          const generationTemplate = get(draft.generationTemplate$);
          const videoOptionsEnabled =
            get(featureSwitch$)[FeatureSwitchKey.VideoTemplateOptions] ?? false;
          const videoOptions = videoOptionsEnabled
            ? videoOptionsForSubmission({
                intentDetected: draftMentionsVideo(get(draft.input$)),
                ...messageVideoTemplateContext(
                  submission.editorDocument,
                  generationTemplate,
                ),
                explicit: get(draft.videoOptions$),
                inherited: get(eventSignals.latestVideoOptions$),
              })
            : undefined;
          return await set(
            options.submitMessage$,
            action,
            {
              prompt,
              generationTemplate,
              videoOptions,
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
