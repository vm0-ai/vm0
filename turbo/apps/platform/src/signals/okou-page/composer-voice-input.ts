import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS,
  voiceIoTranscribeContract,
  type VoiceIoEditorContext,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { logger } from "../log.ts";
import {
  onDomEventFn,
  onRef,
  onRejection,
  settle,
  withCleanup,
  createChildAbortController,
} from "../utils.ts";
import { voiceInputV2Enabled$ } from "../external/feature-switch.ts";
import {
  readVoiceDraftRecording,
  createVoiceDraftRecording,
  appendVoiceDraftSamples,
  readVoiceDraftAudio,
  deleteVoiceDraftRecording,
  type VoiceDraftRecordingRecord,
} from "../external/voice-draft-store.ts";
import { prepareVoiceDraftAudio } from "../voice-io/voice-draft-audio.ts";
import { createVoiceDraftCaptureSignals } from "../voice-io/voice-draft-capture.ts";
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

const L = logger("Composer:VoiceDraft");
export type ComposerVoiceInputStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "failed"
  | "discarding";
type ComposerVoiceAction = "toggle" | "retry" | "discard";
type DeliverVoiceTextCommand = Command<Promise<void>, [string, AbortSignal]>;
interface ComposerVoiceInputState {
  readonly status: "idle" | "recording" | "failed";
  readonly recording: VoiceDraftRecordingRecord | null;
  readonly message?: string;
}
export type ComposerVoiceInputSignals = ReturnType<
  typeof createComposerVoiceInputSignals
>;

function reportVoiceDraftTranscriptionFailure(error: unknown): void {
  L.error("Voice draft transcription failed", error);
  toast.error(
    i18n.t(($) => {
      return $.chat.voice.transcriptionFailed;
    }),
  );
}
function voiceDraftStorageFailedMessage(): string {
  return i18n.t(($) => {
    return $.chat.voice.storageFailed;
  });
}

function createLegacyVoiceToggle(appendText$: Command<void, [string]>) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (
      !get(audioInputAvailable$) ||
      get(sttStarting$) ||
      get(sttTranscribing$)
    ) {
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
      onDomEventFn((text: string) => {
        set(appendText$, text);
      }),
      { autoSegment: quota.limit === null, autoStopOnSilence: true },
      signal,
    );
  });
}

function createVoiceDraftData(draftTarget: string) {
  const storageKey$ = computed(async (get): Promise<string> => {
    const identity = await get(authenticatedIdentity$);
    return JSON.stringify([identity.userId, identity.orgId, draftTarget]);
  });
  const revision$ = state(0);
  // A successful text handoff consumes this recording even if local deletion
  // fails. Keep that domain fact so Retry cannot insert the same text twice.
  const deliveredRecordingId$ = state<string | null>(null);
  const recording$ = computed(
    async (get): Promise<VoiceDraftRecordingRecord | null> => {
      if (!get(voiceInputV2Enabled$)) {
        return null;
      }
      get(revision$);
      const deliveredId = get(deliveredRecordingId$);
      const key = await get(storageKey$);
      const recording = await readVoiceDraftRecording(key);
      return recording?.id === deliveredId ? null : recording;
    },
  );
  const reload$ = command(({ set }) => {
    set(revision$, (value) => {
      return value + 1;
    });
  });
  const capture = createVoiceDraftCaptureSignals();
  const captureError$ = state<unknown>(null);
  const state$ = computed(async (get): Promise<ComposerVoiceInputState> => {
    const active = get(capture.capture$);
    const captureError = get(captureError$);
    const restored = await settle(get(recording$));
    if (!restored.ok) {
      return {
        status: "failed",
        recording: null,
        message: voiceDraftStorageFailedMessage(),
      };
    }
    return {
      status: active ? "recording" : restored.value ? "failed" : "idle",
      recording: restored.value,
      message:
        captureError || restored.value?.sampleCount === 0
          ? voiceDraftStorageFailedMessage()
          : undefined,
    };
  });
  return {
    storageKey$,
    deliveredRecordingId$,
    recording$,
    reload$,
    capture,
    captureError$,
    state$,
  };
}

type VoiceDraftData = ReturnType<typeof createVoiceDraftData>;
type VoiceDraftCommand = Command<Promise<void>, [AbortSignal]>;

function createVoiceDraftTranscription(
  data: VoiceDraftData,
  deliverText$: DeliverVoiceTextCommand,
  readEditorContext$: Command<VoiceIoEditorContext, []>,
  lastAssistantMessage$: Computed<string | undefined>,
) {
  const { recording$, storageKey$, deliveredRecordingId$, reload$ } = data;
  const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
    const recording = await get(recording$);
    signal.throwIfAborted();
    if (!recording) {
      return;
    }
    const key = await get(storageKey$);
    signal.throwIfAborted();
    const blob = await readVoiceDraftAudio(key, recording.id);
    signal.throwIfAborted();
    const files = await prepareVoiceDraftAudio(blob, signal);
    signal.throwIfAborted();
    if (files.length > 0) {
      const formData = new FormData();
      for (const file of files) {
        formData.append("file", file);
      }
      const reference = get(lastAssistantMessage$)
        ?.trim()
        .slice(0, VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS);
      if (reference) {
        formData.append("lastAssistantMessage", reference);
      }
      const editorContext = set(readEditorContext$);
      if (
        editorContext.before ||
        editorContext.selected ||
        editorContext.after
      ) {
        formData.append("editorContext", JSON.stringify(editorContext));
      }
      const result = await accept(
        get(apiClient$)(voiceIoTranscribeContract).post({
          body: formData,
          fetchOptions: { signal },
        }),
        [200, 204, 402, 429],
        signal,
        { showErrorToast: false },
      );
      signal.throwIfAborted();
      if (result.status !== 200 && result.status !== 204) {
        await set(openAudioInputQuotaRecovery$, signal);
        return;
      }
      if (result.status === 200) {
        const text = result.body.polishedText;
        if (!text.trim()) {
          throw new Error("Voice transcription returned empty text");
        }
        await set(deliverText$, text, signal);
      }
      set(refreshAudioInputQuota$);
    }

    signal.throwIfAborted();
    set(deliveredRecordingId$, recording.id);
    const removed = await settle(
      deleteVoiceDraftRecording(key, recording.id),
      signal,
    );
    signal.throwIfAborted();
    set(reload$);
    if (!removed.ok) {
      L.error("Voice recording cleanup failed", removed.error);
      toast.error(
        i18n.t(($) => {
          return $.chat.voice.cleanupFailed;
        }),
      );
    }
  });
  return transcribe$;
}

function createVoiceDraftMutations(
  data: VoiceDraftData,
  transcribe$: VoiceDraftCommand,
) {
  const { recording$, storageKey$, reload$, capture, captureError$ } = data;
  const discard$ = command(async ({ get, set }, signal: AbortSignal) => {
    const recording = await get(recording$);
    signal.throwIfAborted();
    if (recording) {
      const key = await get(storageKey$);
      signal.throwIfAborted();
      await deleteVoiceDraftRecording(key, recording.id);
      signal.throwIfAborted();
    }
    set(reload$);
    await get(recording$);
    signal.throwIfAborted();
  });
  const start$ = command(async ({ get, set }, signal: AbortSignal) => {
    const quota = await get(audioInputQuota$);
    signal.throwIfAborted();
    if (!quota.allowed) {
      await set(openAudioInputQuotaRecovery$, signal);
      return;
    }
    const key = await get(storageKey$);
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const recording = await createVoiceDraftRecording(key, id);
    signal.throwIfAborted();
    set(reload$);
    if (recording.id !== id) {
      return;
    }
    const removeEmptyRecording = async () => {
      const current = await readVoiceDraftRecording(key);
      if (current?.id === id && current.sampleCount === 0) {
        await deleteVoiceDraftRecording(key, id);
      }
      set(reload$);
    };
    set(captureError$, null);
    const started = await settle(
      onRejection(
        set(
          capture.start$,
          {
            append: (samples, sequence) => {
              return appendVoiceDraftSamples(key, id, sequence, samples);
            },
            fail: (error) => {
              L.error("Voice recording could not be saved", error);
              toast.error(voiceDraftStorageFailedMessage());
              set(captureError$, error);
              set(capture.cancel$);
              set(reload$);
            },
          },
          signal,
        ),
        removeEmptyRecording,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!started.ok) {
      throw started.error;
    }
    if (!started.value) {
      await removeEmptyRecording();
      signal.throwIfAborted();
    }
  });
  const finish$ = command(async ({ get, set }, signal: AbortSignal) => {
    const finished = await withCleanup(set(capture.finish$, signal), () => {
      return set(reload$);
    });
    signal.throwIfAborted();
    if (finished && !get(captureError$)) {
      await set(transcribe$, signal);
    }
  });
  return { start$, finish$, discard$, transcribe$ };
}

function createVoiceActionBindings(
  data: VoiceDraftData,
  mutations: ReturnType<typeof createVoiceDraftMutations>,
  legacyToggle$: ReturnType<typeof createLegacyVoiceToggle>,
) {
  const { state$, capture, reload$ } = data;
  const { start$, finish$, discard$, transcribe$ } = mutations;
  const internalOwner$ = state<AbortController | null>(null);
  const owner$ = computed((get) => {
    return get(internalOwner$);
  });
  const element$ = state<HTMLElement | null>(null);
  const invocation$ = state<{
    readonly action: "start" | "finish" | "retry" | "discard";
    readonly owner: AbortController;
  } | null>(null);
  const action$ = computed((get) => {
    const invocation = get(invocation$);
    return invocation?.owner === get(owner$)
      ? (invocation?.action ?? null)
      : null;
  });
  const run$ = command(
    async (
      { get, set },
      action: ComposerVoiceAction,
      parentSignal: AbortSignal,
    ) => {
      if (!get(voiceInputV2Enabled$)) {
        await set(legacyToggle$, parentSignal);
        return;
      }
      const owner = get(owner$);
      if (!owner || !get(audioInputAvailable$)) {
        return;
      }
      const signal = AbortSignal.any([owner.signal, parentSignal]);
      signal.throwIfAborted();
      const current = await get(state$);
      signal.throwIfAborted();
      const resolvedAction =
        action === "toggle"
          ? get(capture.capture$)
            ? "finish"
            : current.status === "failed"
              ? "retry"
              : "start"
          : action;
      set(invocation$, { action: resolvedAction, owner });
      const result = await settle(
        (async () => {
          if (resolvedAction === "start") {
            await set(start$, signal);
          } else if (resolvedAction === "finish") {
            await set(finish$, signal);
          } else if (resolvedAction === "discard") {
            await set(discard$, signal);
          } else {
            set(reload$);
            await set(transcribe$, signal);
          }
        })(),
        signal,
      );
      signal.throwIfAborted();
      if (!result.ok) {
        reportVoiceDraftTranscriptionFailure(result.error);
      }
    },
  );
  const mount$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(element$, element);
      set(internalOwner$, createChildAbortController(signal));
      signal.addEventListener(
        "abort",
        () => {
          set(capture.cancel$);
          set(internalOwner$, null);
          set(element$, null);
          set(reload$);
        },
        { once: true },
      );
    }),
  );
  // The global shortcut activates the same enabled control as a click, so it
  // shares the React invocation's loadable state and cannot bypass disabled UI.
  const toggle$ = command(({ get }) => {
    get(element$)
      ?.querySelector<HTMLButtonElement>("[data-composer-voice-toggle]")
      ?.click();
  });
  return { owner$, action$, run$, setRootRef$: mount$, toggle$ };
}

export function createComposerVoiceInputSignals(
  appendText$: Command<void, [string]>,
  deliverText$: DeliverVoiceTextCommand,
  readEditorContext$: Command<VoiceIoEditorContext, []>,
  lastAssistantMessage$: Computed<string | undefined>,
  draftTarget: string,
) {
  const data = createVoiceDraftData(draftTarget);
  const transcribe$ = createVoiceDraftTranscription(
    data,
    deliverText$,
    readEditorContext$,
    lastAssistantMessage$,
  );
  const actions = createVoiceActionBindings(
    data,
    createVoiceDraftMutations(data, transcribe$),
    createLegacyVoiceToggle(appendText$),
  );
  return {
    ...actions,
    state$: data.state$,
    capture$: data.capture.capture$,
    voiceLevelSamples$: data.capture.voiceLevelSamples$,
  };
}
