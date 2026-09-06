import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
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
  settle,
  withCleanup,
  createChildAbortController,
  createDeferredPromise,
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

export interface ComposerVoiceInputSignals {
  readonly state$: Computed<
    ComposerVoiceInputState | Promise<ComposerVoiceInputState>
  >;
  readonly retry$: Command<Promise<void>, [AbortSignal]>;
  readonly discard$: Command<Promise<void>, [AbortSignal]>;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly toggle$: Command<Promise<void>, [AbortSignal]>;
}

type VoiceDraftTranscriptionCommand = Command<Promise<void>, [AbortSignal]>;
type DeliverVoiceTextCommand = Command<Promise<void>, [string, AbortSignal]>;

interface ComposerVoiceInputState {
  readonly status: ComposerVoiceInputStatus;
  readonly recording: VoiceDraftRecordingRecord | null;
  readonly message?: string;
  readonly attempt?: symbol;
}

interface ComposerVoiceInputStateSignals {
  readonly state$: State<ComposerVoiceInputState | null>;
  readonly current$: ComposerVoiceInputSignals["state$"];
}

function idleVoiceInputState(): ComposerVoiceInputState {
  return { status: "idle", recording: null };
}

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

function createVoiceDraftTranscriptionCommand(
  deliverText$: DeliverVoiceTextCommand,
  readEditorContext$: Command<VoiceIoEditorContext, []>,
  lastAssistantMessage$: Computed<string | undefined>,
  { state$, current$ }: ComposerVoiceInputStateSignals,
  storageKey$: Computed<Promise<string>>,
): VoiceDraftTranscriptionCommand {
  const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
    const current = await get(current$);
    signal.throwIfAborted();
    if (!current.recording) {
      throw new Error("Voice transcription requires a recording");
    }
    const key = await get(storageKey$);
    signal.throwIfAborted();
    const blob = await readVoiceDraftAudio(key, current.recording.id);
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
    // Valid text handoff or a confirmed empty/no-speech result ends recovery.
    // Ordinary text autosave owns any delivered text.
    // Text insertion and local deletion intentionally are not one transaction.
    signal.throwIfAborted();
    set(state$, { ...current, status: "discarding" });
    const removed = await withCleanup(
      settle(deleteVoiceDraftRecording(key, current.recording.id), signal),
      () => {
        if (get(state$)?.attempt === current.attempt) {
          set(state$, idleVoiceInputState());
        }
      },
    );
    signal.throwIfAborted();
    if (!removed.ok) {
      L.error("Voice recording cleanup failed", removed.error);
      toast.error(
        i18n.t(($) => {
          return $.chat.voice.cleanupFailed;
        }),
      );
    }
  });
  return command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = await get(current$);
    signal.throwIfAborted();
    const attempt = Symbol();
    set(state$, {
      ...current,
      attempt,
      status: "transcribing",
      message: undefined,
    });
    const result = await withCleanup(
      settle(set(transcribe$, signal), signal),
      () => {
        const current = get(state$);
        if (current?.attempt === attempt && current.status === "transcribing") {
          set(state$, { ...current, status: "failed" });
        }
      },
    );
    signal.throwIfAborted();
    if (!result.ok) {
      reportVoiceDraftTranscriptionFailure(result.error);
    }
  });
}

function createVoiceDraftRecoverySignals(
  storageKey$: Computed<Promise<string>>,
) {
  const state$ = state<ComposerVoiceInputState | null>(null);
  const revision$ = state(0);
  const restored$ = computed(async (get): Promise<ComposerVoiceInputState> => {
    get(revision$);
    const key = await get(storageKey$);
    const result = await settle(readVoiceDraftRecording(key));
    if (!result.ok) {
      // Keep Retry available when storage cannot be read. Loading is represented
      // by this computed Promise, independently of the recording's domain state.
      return {
        status: "failed",
        recording: null,
        message: voiceDraftStorageFailedMessage(),
      };
    }
    const recording = result.value;
    return recording
      ? {
          status: "failed",
          recording,
          message:
            recording.sampleCount === 0
              ? voiceDraftStorageFailedMessage()
              : undefined,
        }
      : idleVoiceInputState();
  });
  const current$ = computed((get) => {
    if (!get(voiceInputV2Enabled$)) {
      return idleVoiceInputState();
    }
    return get(state$) ?? get(restored$);
  });
  const restore$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(revision$, (revision) => {
      return revision + 1;
    });
    set(state$, null);
    await get(current$);
    signal.throwIfAborted();
  });
  const discard$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = await get(current$);
    signal.throwIfAborted();
    if (current.status !== "failed" || !current.recording) {
      return;
    }
    const recordingId = current.recording.id;
    set(state$, { ...current, status: "discarding" });
    const result = await settle(
      (async () => {
        const key = await get(storageKey$);
        signal.throwIfAborted();
        await deleteVoiceDraftRecording(key, recordingId);
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      set(state$, {
        ...current,
        message: voiceDraftStorageFailedMessage(),
      });
      return;
    }
    await set(restore$, signal);
  });
  return { state$, current$, restore$, discard$ };
}

function createVoiceDraftCaptureCommand(
  { state$ }: ComposerVoiceInputStateSignals,
  transcribe$: VoiceDraftTranscriptionCommand,
) {
  return command(
    async (
      { get, set },
      key: string,
      recording: VoiceDraftRecordingRecord,
      signal: AbortSignal,
    ) => {
      const id = recording.id;
      const captureFinished = createDeferredPromise<void>(signal);
      const writeFailure = createDeferredPromise<void>(signal);
      let failed = false;
      let storageFailed = false;
      const resetOnAbort = () => {
        const current = get(state$);
        if (current?.recording?.id === id) {
          set(state$, { ...current, status: "failed" });
        }
      };
      const finishOwnership = () => {
        signal.removeEventListener("abort", resetOnAbort);
        if (!captureFinished.settled()) {
          captureFinished.resolve();
        }
        if (!writeFailure.settled()) {
          writeFailure.resolve();
        }
      };
      const failCapture = async () => {
        failed = true;
        await withCleanup(
          (async () => {
            const saved = await readVoiceDraftRecording(key);
            signal.throwIfAborted();
            if (!storageFailed && (!saved || saved.sampleCount === 0)) {
              await deleteVoiceDraftRecording(key, id);
              signal.throwIfAborted();
              set(state$, idleVoiceInputState());
            } else {
              set(state$, {
                ...get(state$),
                status: "failed",
                recording: saved,
              });
            }
            if (!storageFailed) {
              reportVoiceDraftTranscriptionFailure(
                new Error("Voice draft recording failed"),
              );
            }
          })(),
          finishOwnership,
        );
      };
      signal.addEventListener("abort", resetOnAbort, { once: true });
      set(state$, { status: "recording", recording });
      await set(
        startRecording$,
        onDomEventFn(() => {}),
        { autoSegment: false, autoStopOnSilence: false },
        {
          persistence: {
            append: (samples, sequence) => {
              return appendVoiceDraftSamples(key, id, sequence, samples);
            },
            fail: (error) => {
              failed = true;
              storageFailed = true;
              L.error("Voice recording could not be saved", error);
              toast.error(voiceDraftStorageFailedMessage());
              set(state$, {
                status: "recording",
                recording,
                message: voiceDraftStorageFailedMessage(),
              });
              if (!writeFailure.settled()) {
                writeFailure.resolve();
              }
            },
          },
          finish: async (captured) => {
            signal.throwIfAborted();
            if (!captured || failed) {
              if (!failed) {
                await failCapture();
              }
              return;
            }
            set(state$, {
              status: "transcribing",
              recording,
            });
            await withCleanup(set(transcribe$, signal), finishOwnership);
          },
          fail: failCapture,
        },
        signal,
      );
      await Promise.race([captureFinished.promise, writeFailure.promise]);
      signal.throwIfAborted();
      if (storageFailed) {
        await set(stopAndTranscribe$, signal);
      }
    },
  );
}

function createStartVoiceDraftRecordingCommand(
  voiceState: ComposerVoiceInputStateSignals,
  storageKey$: Computed<Promise<string>>,
  transcribe$: VoiceDraftTranscriptionCommand,
): Command<Promise<void>, [AbortSignal]> {
  const { state$ } = voiceState;
  const capture$ = createVoiceDraftCaptureCommand(voiceState, transcribe$);
  return command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(state$, { status: "recording", recording: null });
    const key = await get(storageKey$);
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const created = await settle(createVoiceDraftRecording(key, id), signal);
    signal.throwIfAborted();
    if (!created.ok || created.value.id !== id) {
      set(state$, {
        status: "failed",
        recording: created.ok ? created.value : null,
        message: created.ok ? undefined : voiceDraftStorageFailedMessage(),
      });
      return;
    }
    await set(capture$, key, created.value, signal);
  });
}

function createVoiceDraftRetryCommand(
  { state$, current$ }: ComposerVoiceInputStateSignals,
  storageKey$: Computed<Promise<string>>,
  transcribe$: VoiceDraftTranscriptionCommand,
  restore$: VoiceDraftTranscriptionCommand,
) {
  const retry$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = await get(current$);
    signal.throwIfAborted();
    if (current.status !== "failed") {
      return;
    }
    if (!current.recording) {
      await set(restore$, signal);
      return;
    }
    set(state$, { ...current, status: "transcribing" });
    const result = await settle(
      (async () => {
        const key = await get(storageKey$);
        signal.throwIfAborted();
        const saved = await readVoiceDraftRecording(key);
        signal.throwIfAborted();
        if (saved?.id !== current.recording?.id) {
          set(
            state$,
            saved
              ? { status: "failed", recording: saved }
              : idleVoiceInputState(),
          );
          return;
        }
        await set(transcribe$, signal);
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      set(state$, {
        ...current,
        message: voiceDraftStorageFailedMessage(),
      });
    }
  });
  return retry$;
}

function createVoiceDraftOwner(
  recovery: ReturnType<typeof createVoiceDraftRecoverySignals>,
) {
  const owner$ = state<AbortController | null>(null);
  const initialize$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const previous = get(owner$);
    previous?.abort();
    const owner = createChildAbortController(signal);
    set(owner$, owner);
    if (previous) {
      await set(recovery.restore$, owner.signal);
    } else {
      await get(recovery.current$);
      signal.throwIfAborted();
      owner.signal.throwIfAborted();
    }
  });
  const bind = (action$: VoiceDraftTranscriptionCommand) => {
    return command(async ({ get, set }, signal: AbortSignal) => {
      const owner = get(owner$);
      if (!owner) {
        throw new Error("Voice composer has not initialized");
      }
      // A dialog may disappear while its page remains mounted. Stop its work
      // with the committed composer so saved audio can be recovered elsewhere.
      await set(action$, AbortSignal.any([owner.signal, signal]));
    });
  };
  return { initialize$, bind };
}

export function createComposerVoiceInputSignals(
  appendText$: Command<void, [string]>,
  deliverText$: DeliverVoiceTextCommand,
  readEditorContext$: Command<VoiceIoEditorContext, []>,
  lastAssistantMessage$: Computed<string | undefined>,
  draftTarget: string,
): ComposerVoiceInputSignals {
  const storageKey$ = computed(async (get): Promise<string> => {
    const identity = await get(authenticatedIdentity$);
    return JSON.stringify([identity.userId, identity.orgId, draftTarget]);
  });
  const recovery = createVoiceDraftRecoverySignals(storageKey$);
  const { state$, current$ } = recovery;
  const owner = createVoiceDraftOwner(recovery);
  const transcribe$ = createVoiceDraftTranscriptionCommand(
    deliverText$,
    readEditorContext$,
    lastAssistantMessage$,
    recovery,
    storageKey$,
  );
  const start$ = createStartVoiceDraftRecordingCommand(
    recovery,
    storageKey$,
    transcribe$,
  );
  const retry$ = createVoiceDraftRetryCommand(
    recovery,
    storageKey$,
    transcribe$,
    recovery.restore$,
  );
  const toggle$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (!get(audioInputAvailable$) || get(sttStarting$)) {
        return;
      }
      if (get(voiceInputV2Enabled$)) {
        const current = await get(current$);
        signal.throwIfAborted();
        const status = current.status;
        if (status === "failed") {
          await set(retry$, signal);
          return;
        }
        if (status === "recording") {
          if (get(sttRecording$)) {
            set(state$, { ...current, status: "transcribing" });
            await set(stopAndTranscribe$, signal);
          }
          return;
        }
        if (status !== "idle" || get(sttRecording$) || get(sttTranscribing$)) {
          return;
        }
        const quota = await get(audioInputQuota$);
        signal.throwIfAborted();
        if (!quota.allowed) {
          await set(openAudioInputQuotaRecovery$, signal);
          return;
        }
        await set(start$, signal);
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
        onDomEventFn((text: string) => {
          set(appendText$, text);
        }),
        { autoSegment: quota.limit === null, autoStopOnSilence: true },
        undefined,
        signal,
      );
    },
  );
  const ownedToggle$ = owner.bind(toggle$);
  return {
    state$: current$,
    toggle$: command(async ({ get, set }, signal: AbortSignal) => {
      await set(get(voiceInputV2Enabled$) ? ownedToggle$ : toggle$, signal);
    }),
    retry$: owner.bind(retry$),
    discard$: owner.bind(recovery.discard$),
    initialize$: owner.initialize$,
  };
}
