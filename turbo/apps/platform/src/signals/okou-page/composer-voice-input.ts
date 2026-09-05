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
  acquireVoiceDraftLock,
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
  | "restoring"
  | "recording"
  | "transcribing"
  | "failed"
  | "discarding";

export interface ComposerVoiceInputSignals {
  readonly status$: Computed<ComposerVoiceInputStatus>;
  readonly recordingAvailable$: Computed<boolean>;
  readonly retry$: Command<Promise<void>, [AbortSignal]>;
  readonly discard$: Command<Promise<void>, [AbortSignal]>;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly message$: Computed<string | null>;
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

type ComposerVoiceInputStateSignal = State<ComposerVoiceInputState>;

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

class VoiceDraftBusyError extends Error {}

function voiceDraftRecoveryMessage(error: unknown): string {
  return error instanceof VoiceDraftBusyError
    ? error.message
    : voiceDraftStorageFailedMessage();
}

async function lockVoiceDraft(
  key: string,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const release = await acquireVoiceDraftLock(key, signal);
  if (!release) {
    throw new VoiceDraftBusyError(
      i18n.t(($) => {
        return $.chat.voice.busyInAnotherTab;
      }),
    );
  }
  return release;
}

function createVoiceDraftTranscriptionCommand(
  deliverText$: DeliverVoiceTextCommand,
  lastAssistantMessage$: Computed<string | undefined>,
  state$: ComposerVoiceInputStateSignal,
  storageKey$: Computed<Promise<string>>,
): VoiceDraftTranscriptionCommand {
  const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(state$);
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
        if (get(state$).attempt === current.attempt) {
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
    const attempt = Symbol();
    set(state$, {
      ...get(state$),
      attempt,
      status: "transcribing",
      message: undefined,
    });
    const result = await withCleanup(
      settle(set(transcribe$, signal), signal),
      () => {
        const current = get(state$);
        if (current.attempt === attempt && current.status === "transcribing") {
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
  state$: ComposerVoiceInputStateSignal,
  storageKey$: Computed<Promise<string>>,
) {
  const restore$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const attempt = Symbol();
    set(state$, { status: "restoring", recording: null, attempt });
    const result = await settle(
      (async () => {
        const key = await get(storageKey$);
        signal.throwIfAborted();
        const release = await lockVoiceDraft(key, signal);
        return await withCleanup(readVoiceDraftRecording(key), release);
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (get(state$).attempt !== attempt) {
      return;
    }
    if (!result.ok) {
      set(state$, {
        status: "failed",
        recording: null,
        message: voiceDraftRecoveryMessage(result.error),
      });
      return;
    }
    set(
      state$,
      result.value
        ? {
            status: "failed",
            recording: result.value,
            message:
              result.value.sampleCount === 0
                ? voiceDraftStorageFailedMessage()
                : undefined,
          }
        : idleVoiceInputState(),
    );
  });
  const discard$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = get(state$);
    if (current.status !== "failed" || !current.recording) {
      return;
    }
    const recordingId = current.recording.id;
    set(state$, { ...current, status: "discarding" });
    const result = await settle(
      (async () => {
        const key = await get(storageKey$);
        signal.throwIfAborted();
        const release = await lockVoiceDraft(key, signal);
        await withCleanup(deleteVoiceDraftRecording(key, recordingId), release);
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      set(state$, {
        ...current,
        message: voiceDraftRecoveryMessage(result.error),
      });
      return;
    }
    await set(restore$, signal);
  });
  return { restore$, discard$ };
}

function createVoiceDraftCaptureCommand(
  state$: ComposerVoiceInputStateSignal,
  transcribe$: VoiceDraftTranscriptionCommand,
) {
  return command(
    async (
      { get, set },
      key: string,
      recording: VoiceDraftRecordingRecord,
      release: () => Promise<void>,
      signal: AbortSignal,
    ) => {
      const id = recording.id;
      const captureFinished = createDeferredPromise<void>(signal);
      const writeFailure = createDeferredPromise<void>(signal);
      let failed = false;
      let storageFailed = false;
      const resetOnAbort = () => {
        if (get(state$).recording?.id === id) {
          set(state$, { ...get(state$), status: "failed" });
        }
      };
      const finishOwnership = async () => {
        signal.removeEventListener("abort", resetOnAbort);
        if (!captureFinished.settled()) {
          captureFinished.resolve();
        }
        if (!writeFailure.settled()) {
          writeFailure.resolve();
        }
        await release();
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
              set(state$, { ...get(state$), status: "failed" });
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
                ...get(state$),
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
  state$: ComposerVoiceInputStateSignal,
  storageKey$: Computed<Promise<string>>,
  transcribe$: VoiceDraftTranscriptionCommand,
): Command<Promise<void>, [AbortSignal]> {
  const capture$ = createVoiceDraftCaptureCommand(state$, transcribe$);
  return command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(state$, { status: "restoring", recording: null });
    const key = await get(storageKey$);
    signal.throwIfAborted();
    const locked = await settle(lockVoiceDraft(key, signal), signal);
    signal.throwIfAborted();
    if (!locked.ok) {
      set(state$, {
        status: "failed",
        recording: null,
        message: voiceDraftRecoveryMessage(locked.error),
      });
      return;
    }
    const release = locked.value;
    const id = crypto.randomUUID();
    const created = await settle(createVoiceDraftRecording(key, id), signal);
    signal.throwIfAborted();
    if (!created.ok || created.value.id !== id) {
      await release();
      signal.throwIfAborted();
      set(state$, {
        status: "failed",
        recording: created.ok ? created.value : null,
        message: created.ok ? undefined : voiceDraftStorageFailedMessage(),
      });
      return;
    }
    await set(capture$, key, created.value, release, signal);
  });
}

function createVoiceDraftRetryCommand(
  state$: ComposerVoiceInputStateSignal,
  storageKey$: Computed<Promise<string>>,
  transcribe$: VoiceDraftTranscriptionCommand,
  restore$: VoiceDraftTranscriptionCommand,
) {
  const retry$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = get(state$);
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
        const release = await lockVoiceDraft(key, signal);
        await withCleanup(
          (async () => {
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
          release,
        );
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      set(state$, {
        ...current,
        message: voiceDraftRecoveryMessage(result.error),
      });
    }
  });
  return retry$;
}

function createVoiceDraftOwner(restore$: VoiceDraftTranscriptionCommand) {
  const owner$ = state<AbortController | null>(null);
  const initialize$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    get(owner$)?.abort();
    const owner = createChildAbortController(signal);
    set(owner$, owner);
    await set(restore$, owner.signal);
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
  lastAssistantMessage$: Computed<string | undefined>,
  draftTarget: string,
): ComposerVoiceInputSignals {
  const state$ = state<ComposerVoiceInputState>({
    status: "restoring",
    recording: null,
  });
  const status$ = computed((get): ComposerVoiceInputStatus => {
    return get(voiceInputV2Enabled$) ? get(state$).status : "idle";
  });
  const storageKey$ = computed(async (get): Promise<string> => {
    const identity = await get(authenticatedIdentity$);
    return JSON.stringify([identity.userId, identity.orgId, draftTarget]);
  });
  const recovery = createVoiceDraftRecoverySignals(state$, storageKey$);
  const owner = createVoiceDraftOwner(recovery.restore$);
  const transcribe$ = createVoiceDraftTranscriptionCommand(
    deliverText$,
    lastAssistantMessage$,
    state$,
    storageKey$,
  );
  const start$ = createStartVoiceDraftRecordingCommand(
    state$,
    storageKey$,
    transcribe$,
  );
  const retry$ = createVoiceDraftRetryCommand(
    state$,
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
        const status = get(state$).status;
        if (status === "failed") {
          await set(retry$, signal);
          return;
        }
        if (status === "recording") {
          set(state$, { ...get(state$), status: "transcribing" });
          await set(stopAndTranscribe$, signal);
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
    status$,
    message$: computed((get) => {
      return get(state$).message ?? null;
    }),
    recordingAvailable$: computed((get) => {
      return get(state$).recording !== null;
    }),
    toggle$: command(async ({ get, set }, signal: AbortSignal) => {
      await set(get(voiceInputV2Enabled$) ? ownedToggle$ : toggle$, signal);
    }),
    retry$: owner.bind(retry$),
    discard$: owner.bind(recovery.discard$),
    initialize$: owner.initialize$,
  };
}
