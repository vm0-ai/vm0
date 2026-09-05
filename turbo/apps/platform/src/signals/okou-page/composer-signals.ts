import type {
  ChatRunVideoOptionsRequest,
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { foldActiveChatGoalObjective } from "@okouai/api-contracts/contracts/chat-events";
import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
import {
  VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS,
  voiceIoTranscribeContract,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import type { VideoModel } from "@okouai/core/video-model-catalog";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { onDomEventFn, onRef, settle, withCleanup } from "../utils.ts";
import {
  featureSwitch$,
  voiceDraftEnabled$,
} from "../external/feature-switch.ts";
import {
  audioInputAvailable$,
  audioInputQuota$,
  openAudioInputQuotaRecovery$,
  refreshAudioInputQuota$,
  sttRecording$,
  sttStarting$,
  sttTranscribing$,
  startRecording$,
  stopAndTranscribe$,
} from "../voice-io/voice-io-stt.ts";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import type { DraftSignals, ChatAttachment } from "./chat-draft.ts";
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
} from "./connectors.ts";
import {
  createComposerUiSignals,
  type ComposerUiSignalGroups,
} from "./chat-composer.ts";
import { videoRunOptionsForSend } from "./video-run-options.ts";
import {
  createImageAnnotationSignals,
  type ImageAnnotationSignals,
} from "./image-annotation.ts";
import {
  CREATE_WORKFLOW_WITH_CHAT_PROMPT,
  replaceWorkflowPromptDraftTarget$,
  setReplaceWorkflowPromptDraftTarget$,
} from "../chat-page/workflow-prompt-action.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { logger } from "../log.ts";
import { prepareVoiceDraftAudio } from "../voice-io/voice-draft-audio.ts";
import { i18n } from "../../i18n/index.ts";
import { toast } from "@okouai/ui/components/ui/sonner";

const L = logger("Composer:VoiceDraft");

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
  | "openTemplatePicker$"
>;

type ComposerModelUiSignals = ComposerUiSignalGroups["model"];
type ComposerVideoOptionsSignals = ComposerUiSignalGroups["videoOptions"];
type ComposerTemplateUiSignals = ComposerUiSignalGroups["template"];

export interface ComposerSubmission {
  readonly prompt: string;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly editorDocument: WorkflowComposerSubmissionSnapshot["editorDocument"];
  /**
   * Video parameters for this send only. Absent unless the user moved one off
   * the effective model's default; the send path forwards it as a run option
   * rather than writing it anywhere.
   */
  readonly videoRunOptions: ChatRunVideoOptionsRequest | undefined;
}

export type ComposerSubmissionAction = "send" | "queue";

export type ComposerPrimaryAction =
  | ComposerSubmissionAction
  | "stop"
  | "disabled";

export interface ComposerPendingEvent {
  readonly kind: "message" | "automation";
  readonly id: string;
  readonly text: string;
}

interface ComposerWorkflowSignals extends ComposerWorkflowEditorSignals {
  readonly createWorkflowPrompt$: Command<Promise<void>, [AbortSignal]>;
  readonly replaceWorkflowPromptOpen$: Computed<boolean>;
  readonly confirmReplaceWorkflowPrompt$: Command<Promise<void>, [AbortSignal]>;
  readonly setReplaceWorkflowPromptOpen$: Command<void, [boolean]>;
}

interface ComposerDraftSignals {
  readonly seed$: DraftSignals["seed$"];
  readonly setDraftInput$: Command<void, [string]>;
  readonly attachments$: Computed<ChatAttachment[]>;
  readonly attachmentUploadsReady$: Computed<boolean>;
  readonly uploadAttachment$: Command<Promise<void>, [File, AbortSignal]>;
  readonly restoreAttachments$: DraftSignals["restoreAttachments$"];
  readonly removeAttachment$: Command<void, [ChatAttachment]>;
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

/** Video model selected for the composer, when that surface supports it. */
export interface ComposerVideoModelSignals {
  readonly selectedVideoModel$: Computed<
    VideoModel | null | Promise<VideoModel | null>
  >;
  /**
   * The model a video run started from this composer would actually use, with
   * the thread pin, the member default and the system default already folded
   * in. `selectedVideoModel$` is the pin alone, which is null far more often
   * than the run is unconfigured, so it cannot answer "which values does the
   * parameter panel offer".
   */
  readonly effectiveVideoModel$: Computed<VideoModel | Promise<VideoModel>>;
  readonly setVideoModel$: Command<
    Promise<void>,
    [VideoModel | null, AbortSignal]
  >;
}

/** Image model selected for a composer that supports image generation. */
export interface ComposerImageModelSignals {
  readonly selectedImageModel$: Computed<
    ImageModel | null | Promise<ImageModel | null>
  >;
  readonly effectiveImageModel$: Computed<ImageModel | Promise<ImageModel>>;
  readonly setImageModel$: Command<
    Promise<void>,
    [ImageModel | null, AbortSignal]
  >;
}

interface ComposerComputerSignals {
  readonly computerUseHostId$: Computed<string | null>;
  readonly cloudBrowserEnabled$: Computed<boolean | Promise<boolean>>;
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

export type ComposerVoiceInputStatus = "idle" | "recording" | "transcribing";

interface ComposerVoiceInputSignals {
  readonly status$: Computed<ComposerVoiceInputStatus>;
  readonly toggle$: Command<Promise<void>, [AbortSignal]>;
}

export interface ComposerSignals {
  readonly agentId: string;
  readonly editor: ComposerEditorSignals;
  readonly voice: ComposerVoiceInputSignals;
  readonly feedback: WorkflowComposerSignals["feedback"];
  readonly workflow: ComposerWorkflowSignals;
  readonly suggestion: ComposerSuggestionSignals;
  readonly connector: ComposerConnectorSignals;
  readonly draft: ComposerDraftSignals;
  readonly model: ComposerModelSignals;
  readonly imageModel?: ComposerImageModelSignals;
  readonly videoModel?: ComposerVideoModelSignals;
  readonly videoOptions: ComposerVideoOptionsSignals;
  readonly computer: ComposerComputerSignals;
  readonly submission: ComposerSubmissionSignals;
  readonly queue: ComposerQueueSignals;
  readonly goal: ComposerGoalSignals;
  readonly template: ComposerTemplateSignals;
  readonly imageAnnotation: ImageAnnotationSignals;
  readonly setImageAnnotationLifecycleRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

interface CreateComposerSignalsOptions {
  readonly agentId: string;
  readonly draft: {
    readonly signals: DraftSignals;
    readonly save$: ComposerDraftSignals["save$"];
  };
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly threadId?: string;
  readonly connector?: ComposerConnectorSignals;
  readonly singleLineOnMobile: boolean;
  readonly modelSelection$: ComposerModelSignals["modelSelection$"];
  readonly selectedModelOauthAvailable$: ComposerModelSignals["selectedModelOauthAvailable$"];
  readonly setModelSelection$: ComposerModelSignals["setModelSelection$"];
  readonly configureSelectedModel$: ComposerModelSignals["configureSelectedModel$"];
  readonly imageModel?: ComposerImageModelSignals;
  readonly videoModel?: ComposerVideoModelSignals;
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
    insertTemplate$: composer.insertTemplate$,
    openTemplatePicker$: composer.openTemplatePicker$,
  };
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

type VoiceDraftTranscriptionCommand = Command<Promise<void>, [AbortSignal]>;

interface ComposerVoiceInputState {
  readonly status: ComposerVoiceInputStatus;
  readonly recording: Blob | null;
}

type ComposerVoiceInputStateSignal = State<ComposerVoiceInputState>;

function idleVoiceInputState(): ComposerVoiceInputState {
  return { status: "idle", recording: null };
}

function voiceDraftTranscriptionFailedMessage(): string {
  return i18n.t(($) => {
    return $.chat.voice.transcriptionFailed;
  });
}

function reportVoiceDraftTranscriptionFailure(error: unknown): void {
  L.error("Voice draft transcription failed", error);
  toast.error(voiceDraftTranscriptionFailedMessage());
}

function createVoiceDraftTranscriptionCommand(
  workflowComposer: WorkflowComposerSignals,
  draft: Pick<CreateComposerSignalsOptions["draft"], "save$">,
  lastAssistantMessage$: Computed<string | undefined>,
  state$: ComposerVoiceInputStateSignal,
): VoiceDraftTranscriptionCommand {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const voiceInput = get(state$);
    if (voiceInput.status !== "transcribing" || !voiceInput.recording) {
      set(state$, idleVoiceInputState());
      reportVoiceDraftTranscriptionFailure(
        new Error("Voice draft transcription started without a recording"),
      );
      return;
    }
    const prepared = await settle(
      prepareVoiceDraftAudio(voiceInput.recording, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!prepared.ok) {
      set(state$, idleVoiceInputState());
      reportVoiceDraftTranscriptionFailure(prepared.error);
      return;
    }

    const formData = new FormData();
    for (const file of prepared.value) {
      formData.append("file", file);
    }
    const boundedReference = get(lastAssistantMessage$)
      ?.trim()
      .slice(0, VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS);
    if (boundedReference) {
      formData.append("lastAssistantMessage", boundedReference);
    }

    const client = get(apiClient$)(voiceIoTranscribeContract);
    const result = await settle(
      accept(
        client.post({ body: formData, fetchOptions: { signal } }),
        [200, 402, 429],
        signal,
        { showErrorToast: false },
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      set(state$, idleVoiceInputState());
      reportVoiceDraftTranscriptionFailure(result.error);
      return;
    }
    if (result.value.status !== 200) {
      set(state$, idleVoiceInputState());
      await set(openAudioInputQuotaRecovery$, signal);
      return;
    }

    set(workflowComposer.insertText$, result.value.body.polishedText);
    set(state$, idleVoiceInputState());
    await set(draft.save$, signal);
    set(refreshAudioInputQuota$);
  });
}

function createStartVoiceDraftRecordingCommand(
  state$: ComposerVoiceInputStateSignal,
  transcribe$: VoiceDraftTranscriptionCommand,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const resetOnAbort = () => {
      set(state$, idleVoiceInputState());
    };
    const releaseAbortHandler = () => {
      signal.removeEventListener("abort", resetOnAbort);
    };
    signal.addEventListener("abort", resetOnAbort, { once: true });
    set(state$, { status: "recording", recording: null });
    await set(
      startRecording$,
      onDomEventFn(() => {}),
      { autoSegment: false, autoStopOnSilence: false },
      {
        started: () => {
          return undefined;
        },
        finish: (recording) => {
          if (!recording) {
            releaseAbortHandler();
            set(state$, idleVoiceInputState());
            return Promise.resolve();
          }
          set(state$, {
            status: "transcribing",
            recording: recording.blob,
          });
          return withCleanup(set(transcribe$, signal), releaseAbortHandler);
        },
        fail: () => {
          releaseAbortHandler();
          set(state$, idleVoiceInputState());
          reportVoiceDraftTranscriptionFailure(
            new Error("Voice draft recording failed"),
          );
          return Promise.resolve();
        },
      },
      signal,
    );
  });
}

function createComposerVoiceInputSignals(
  workflowComposer: WorkflowComposerSignals,
  draft: Pick<CreateComposerSignalsOptions["draft"], "save$">,
  lastAssistantMessage$: Computed<string | undefined>,
): ComposerVoiceInputSignals {
  const state$ = state<ComposerVoiceInputState>(idleVoiceInputState());
  const status$ = computed((get): ComposerVoiceInputStatus => {
    return get(state$).status;
  });
  const transcribe$ = createVoiceDraftTranscriptionCommand(
    workflowComposer,
    draft,
    lastAssistantMessage$,
    state$,
  );
  const startVoiceDraftRecording$ = createStartVoiceDraftRecordingCommand(
    state$,
    transcribe$,
  );
  const toggle$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (!get(audioInputAvailable$) || get(sttStarting$)) {
        return;
      }
      if (get(voiceDraftEnabled$)) {
        const status = get(state$).status;
        if (status === "transcribing") {
          return;
        }
        if (status === "recording") {
          set(state$, { status: "transcribing", recording: null });
          await set(stopAndTranscribe$, signal);
          return;
        }
        if (get(sttRecording$) || get(sttTranscribing$)) {
          return;
        }
        const quota = await get(audioInputQuota$);
        signal.throwIfAborted();
        if (!quota.allowed) {
          await set(openAudioInputQuotaRecovery$, signal);
          return;
        }
        await set(startVoiceDraftRecording$, signal);
        return;
      }

      if (get(sttTranscribing$)) {
        return;
      }
      if (get(sttRecording$)) {
        await set(stopAndTranscribe$, signal);
        return;
      }
      const quota = await get(audioInputQuota$);
      signal.throwIfAborted();
      if (!quota.allowed) {
        await set(openAudioInputQuotaRecovery$, signal);
        return;
      }
      await set(
        startRecording$,
        onDomEventFn(async (text: string) => {
          set(workflowComposer.appendText$, text);
          await set(draft.save$, signal);
        }),
        { autoSegment: quota.limit === null, autoStopOnSilence: true },
        undefined,
        signal,
      );
    },
  );
  return { status$, toggle$ };
}

function createTemporaryModelNoticeEnabled(
  options: CreateComposerSignalsOptions,
): Computed<boolean> {
  return computed((get): boolean => {
    return (
      options.threadId === undefined &&
      (get(featureSwitch$)[FeatureSwitchKey.NewChatDefaultModelAction] ?? false)
    );
  });
}

export function createComposerSignals(
  options: CreateComposerSignalsOptions,
): ComposerSignals {
  const eventSignals = createComposerChatEventSignals(options.chatEvents$);
  const draft = options.draft.signals;
  const agentId$ = computed((): string => {
    return options.agentId;
  });
  const feedback = createComposerFeedbackModel();
  const temporaryModelNoticeEnabled$ =
    createTemporaryModelNoticeEnabled(options);
  const ui = createComposerUiSignals();
  const workflowComposer = createWorkflowComposerSignals(
    draft,
    ui.openTemplatePickerDialog$,
    agentId$,
    {
      autoFocus: true,
      singleLineOnMobile: options.singleLineOnMobile,
    },
    feedback,
  );
  const voice = createComposerVoiceInputSignals(
    workflowComposer,
    options.draft,
    eventSignals.lastAssistantMessage$,
  );
  const submission = createComposerSubmissionSignals(
    options,
    eventSignals,
    workflowComposer,
    ui.videoOptions,
    voice.status$,
  );
  const fileInput = createComposerFileInputSignals();
  const workflowPrompt = createComposerWorkflowPromptSignals(
    options,
    workflowComposer,
  );
  const imageAnnotation = createImageAnnotationSignals();
  /**
   * Teardown owner for the annotation session and its in-flight derivative
   * uploads. The element itself is not part of the work, but its committed
   * presence is: `ImageAnnotationEditor` renders inside this exact subtree, so
   * the subtree leaving the tree is what makes an open session and a pending
   * upload unreachable. An abandoned upload would otherwise leave the
   * attachment stuck in `pending`, blocking every later send on the restored
   * draft with no retry affordance.
   *
   * `createComposerSignals` takes no lifecycle signal today, so this is the
   * narrowest available owner. Replace it with an injected `AbortSignal` if
   * the composer factory ever gains one.
   */
  const setImageAnnotationLifecycleRef$ = onRef<HTMLElement>(
    command(({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener(
        "abort",
        () => {
          set(imageAnnotation.closeAnnotationEditor$);
          for (const attachment of get(draft.attachments$)) {
            set(attachment.cancelAnnotationUpload$);
          }
        },
        { once: true },
      );
    }),
  );

  return {
    agentId: options.agentId,
    editor: composerEditorSignals(workflowComposer, options.singleLineOnMobile),
    voice,
    feedback: workflowComposer.feedback,
    workflow: {
      ...composerWorkflowSignals(workflowComposer),
      ...workflowPrompt,
    },
    suggestion: composerSuggestionSignals(workflowComposer),
    connector:
      options.connector ??
      createComposerConnectorSignals(options.agentId, options.threadId),
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
    ...(options.imageModel ? { imageModel: options.imageModel } : {}),
    ...(options.videoModel ? { videoModel: options.videoModel } : {}),
    videoOptions: ui.videoOptions,
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
    imageAnnotation,
    setImageAnnotationLifecycleRef$,
  };
}

/**
 * Automation events fired by a watched chat run carry an agent-run source
 * annotation instead of an automation part, so the document text is the label
 * whenever no workflow annotation survived.
 */
function pendingAutomationEventText(
  userMessage: UserMessageDocument | undefined,
): string {
  const automationPart = userMessage?.parts.find((part) => {
    return part.type === "automation";
  });
  if (automationPart?.type === "automation") {
    return (
      automationPart.automationBrief ?? automationPart.workflowName
    ).trim();
  }
  return (messageDocumentToDisplayText(userMessage) ?? "").trim();
}

function createComposerChatEventSignals(chatEvents$: Computed<ChatEvent[]>) {
  const lastAssistantMessage$ = computed((get): string | undefined => {
    const events = get(chatEvents$);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.eventType !== "output.message") {
        continue;
      }
      const content = event.content.trim();
      if (content.length > 0) {
        return content.slice(-VOICE_IO_POLISH_MAX_TEXT_CHARS);
      }
    }
    return undefined;
  });
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
          return event.eventType === "input.automation"
            ? {
                kind: "automation" as const,
                id: event.id,
                text: pendingAutomationEventText(event.userMessage),
              }
            : {
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
    lastAssistantMessage$,
    actionsLoading$,
    sending$,
    runningModelSelection$,
    pendingEvents$,
    activeGoalObjective$,
    hasEvents$,
  };
}

/**
 * Resolved at send rather than held settled, so the parameters follow a video
 * model the user changed after setting them. Nothing is sent when the run
 * would use that model's defaults anyway.
 */
function createVideoRunOptionsSignal(
  videoModel: ComposerVideoModelSignals | undefined,
  videoOptions: ComposerVideoOptionsSignals,
): Command<Promise<ChatRunVideoOptionsRequest | undefined>, [AbortSignal]> {
  return command(async ({ get }, signal: AbortSignal) => {
    if (!videoModel) {
      return undefined;
    }
    const patch = get(videoOptions.videoRunOptions$);
    if (Object.keys(patch).length === 0) {
      return undefined;
    }
    const model = await get(videoModel.effectiveVideoModel$);
    signal.throwIfAborted();
    return videoRunOptionsForSend(patch, model);
  });
}

function createComposerPrimaryActionSignal(args: {
  readonly options: CreateComposerSignalsOptions;
  readonly eventSignals: ReturnType<typeof createComposerChatEventSignals>;
  readonly workflowComposer: WorkflowComposerSignals;
  readonly submissionPending$: Computed<boolean>;
  readonly voiceStatus$: Computed<ComposerVoiceInputStatus>;
}): Computed<Promise<ComposerPrimaryAction>> {
  const { options, eventSignals, workflowComposer } = args;
  const draft = options.draft.signals;
  return computed(async (get): Promise<ComposerPrimaryAction> => {
    if (await get(eventSignals.actionsLoading$)) {
      return "disabled";
    }
    if (get(args.voiceStatus$) !== "idle") {
      return "disabled";
    }

    const uploadsReady = get(draft.attachmentUploadsReady$);
    const attachments = get(draft.attachments$);
    const hasContent =
      get(workflowComposer.hasInput$) || attachments.length > 0;
    const canSend = uploadsReady && hasContent;
    const sending = await get(eventSignals.sending$);
    if (sending && !canSend) {
      return "stop";
    }
    if (get(args.submissionPending$)) {
      return "disabled";
    }
    if (!canSend) {
      return "disabled";
    }
    if (!sending) {
      return "send";
    }
    return "queue";
  });
}

function createComposerSubmissionSignals(
  options: CreateComposerSignalsOptions,
  eventSignals: ReturnType<typeof createComposerChatEventSignals>,
  workflowComposer: WorkflowComposerSignals,
  videoOptions: ComposerVideoOptionsSignals,
  voiceStatus$: Computed<ComposerVoiceInputStatus>,
) {
  const draft = options.draft.signals;
  const readVideoRunOptions$ = createVideoRunOptionsSignal(
    options.videoModel,
    videoOptions,
  );
  const internalSubmissionPending$ = state(false);
  const submissionPending$ = computed((get): boolean => {
    return get(internalSubmissionPending$);
  });
  const primaryAction$ = createComposerPrimaryActionSignal({
    options,
    eventSignals,
    workflowComposer,
    submissionPending$,
    voiceStatus$,
  });
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
      if (get(voiceStatus$) !== "idle") {
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
          const visiblePrompt = submission.prompt.trim();
          if (
            visiblePrompt.length === 0 &&
            get(draft.attachments$).length === 0
          ) {
            return false;
          }
          if (!get(draft.attachmentUploadsReady$)) {
            return false;
          }
          const videoRunOptions = await set(readVideoRunOptions$, signal);
          return await set(
            options.submitMessage$,
            action,
            {
              prompt: visiblePrompt,
              generationTemplate: get(draft.generationTemplate$),
              editorDocument: submission.editorDocument,
              videoRunOptions,
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
