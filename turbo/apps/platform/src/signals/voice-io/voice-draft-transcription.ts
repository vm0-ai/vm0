import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS,
  type VoiceIoTranscribeContext,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import {
  readVoiceDraftRecording,
  readVoiceDraftAudio,
  type VoiceDraftSegment,
} from "../external/voice-draft-store.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  settle,
} from "../utils.ts";
import { nextVoiceDraftSegment } from "./voice-draft-audio.ts";
import { VOICE_DRAFT_PCM_SAMPLE_RATE } from "./voice-draft-pcm.ts";
import { createVoiceDraftSegmentResult } from "./voice-draft-transcription-segment.ts";
import {
  openAudioInputQuotaRecovery$,
  refreshAudioInputQuota$,
} from "./voice-io-stt.ts";

interface VoiceDraftTranscriptionOptions {
  readonly storageKey$: Computed<Promise<string>>;
  readonly readContext$: Command<VoiceIoTranscribeContext, []>;
}

interface VoiceDraftTranscriptionSession {
  readonly key: string;
  readonly recordingId: string;
  readonly context?: VoiceIoTranscribeContext;
  readonly controller: AbortController;
}

interface VoiceDraftTranscriptionSegment {
  readonly segment?: VoiceDraftSegment;
  readonly totalDurationSeconds: number;
  readonly result$: ReturnType<typeof createVoiceDraftSegmentResult>;
}

function createSegment(
  session: VoiceDraftTranscriptionSession,
  segment: VoiceDraftSegment | undefined,
  previous: VoiceDraftTranscriptionSegment | undefined,
  totalDurationSeconds: number,
): VoiceDraftTranscriptionSegment {
  if (!session.context) {
    throw new Error("Voice transcription context has not been captured");
  }
  return {
    segment,
    totalDurationSeconds,
    result$: createVoiceDraftSegmentResult(
      {
        key: session.key,
        recordingId: session.recordingId,
        context: session.context,
        segment,
        previous$: previous?.result$,
        totalDurationSeconds,
      },
      session.controller.signal,
    ),
  };
}

function isFinalSegment(
  entry: VoiceDraftTranscriptionSegment | undefined,
): boolean {
  return entry !== undefined && (entry.segment?.final ?? true);
}

function createTranscriptionState() {
  const session$ = state<VoiceDraftTranscriptionSession | null>(null);
  const segments$ = state<readonly VoiceDraftTranscriptionSegment[]>([]);
  const preparationError$ = state<unknown>(null);
  const result$ = computed(async (get) => {
    const last = get(segments$).at(-1);
    return last ? await get(last.result$) : undefined;
  });
  const wake$ = state<ReturnType<typeof createDeferredPromise<void>> | null>(
    null,
  );
  const notify$ = command(({ get }) => {
    const wake = get(wake$);
    if (wake && !wake.settled()) {
      wake.resolve();
    }
  });

  return { session$, segments$, preparationError$, result$, wake$, notify$ };
}

type TranscriptionState = ReturnType<typeof createTranscriptionState>;

function createInitialization(
  options: VoiceDraftTranscriptionOptions,
  state: TranscriptionState,
) {
  const { session$, segments$, preparationError$, result$ } = state;
  const initialize$ = command(async ({ get, set }, signal: AbortSignal) => {
    const key = await get(options.storageKey$);
    signal.throwIfAborted();
    const recording = await readVoiceDraftRecording(key);
    signal.throwIfAborted();
    if (!recording) {
      return;
    }
    const current = get(session$);
    if (
      current?.recordingId === recording.id &&
      !current.controller.signal.aborted
    ) {
      return;
    }
    current?.controller.abort();
    await Promise.allSettled([get(result$)]);
    signal.throwIfAborted();
    if (get(session$) !== current) {
      return;
    }
    const session = {
      key,
      recordingId: recording.id,
      context: recording.progress?.context,
      controller: createChildAbortController(signal),
    };
    const restored: VoiceDraftTranscriptionSegment[] = [];
    for (const segment of recording.progress?.segments ?? []) {
      restored.push(
        createSegment(
          session,
          segment,
          restored.at(-1),
          recording.sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE,
        ),
      );
    }
    set(session$, session);
    set(segments$, restored);
    set(preparationError$, null);
  });

  return initialize$;
}

function createSegmentPreparation(
  options: VoiceDraftTranscriptionOptions,
  state: TranscriptionState,
) {
  const { session$, segments$, preparationError$, notify$ } = state;
  // The recorder's ordered PCM writes call this after saving audio. Preparing a
  // new segment never waits for HTTP; Stop flushes those writes before sealing
  // the tail through the same command.
  const prepare$ = command(
    async ({ get, set }, finished: boolean, signal: AbortSignal) => {
      let session = get(session$);
      if (!session) {
        return;
      }
      const existing = get(segments$);
      const entries = [...existing];
      const last = entries.at(-1);
      if (isFinalSegment(last)) {
        return;
      }
      const recording = await readVoiceDraftRecording(session.key);
      signal.throwIfAborted();
      if (recording?.id !== session.recordingId) {
        throw new Error("Voice recording changed during transcription");
      }
      let startSample = last?.segment?.endSample ?? 0;
      const remaining = recording.sampleCount - startSample;
      if (
        !finished &&
        remaining <
          VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS * VOICE_DRAFT_PCM_SAMPLE_RATE
      ) {
        return;
      }
      if (!session.context) {
        session = { ...session, context: set(options.readContext$) };
        set(session$, session);
      }
      const audio = await readVoiceDraftAudio(session.key, session.recordingId);
      signal.throwIfAborted();
      const totalDurationSeconds =
        recording.sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE;
      while (startSample < recording.sampleCount) {
        const segment = await nextVoiceDraftSegment(
          audio,
          startSample,
          finished,
          signal,
        );
        if (!segment) {
          break;
        }
        entries.push(
          createSegment(session, segment, entries.at(-1), totalDurationSeconds),
        );
        startSample = segment.endSample;
      }
      if (finished && !isFinalSegment(entries.at(-1))) {
        entries.push(
          createSegment(
            session,
            undefined,
            entries.at(-1),
            totalDurationSeconds,
          ),
        );
      }
      if (get(segments$) !== existing) {
        return;
      }
      set(segments$, entries);
      set(notify$);
    },
  );

  const append$ = command(
    async ({ get, set }, finished: boolean, signal: AbortSignal) => {
      if (finished) {
        await set(prepare$, true, signal);
      } else if (!get(preparationError$)) {
        const prepared = await settle(set(prepare$, false, signal), signal);
        if (!prepared.ok) {
          // A failed speech detector must not stop the recorder's PCM writes.
          // Stop/Retry prepares the retained audio again.
          set(preparationError$, prepared.error);
        }
      }
    },
  );

  return append$;
}

function createCheckpointRetry(state: TranscriptionState) {
  const { session$, segments$ } = state;
  const retry$ = command(async ({ get, set }, signal: AbortSignal) => {
    const session = get(session$);
    if (!session) {
      return;
    }
    const entries = get(segments$);
    const recording = await readVoiceDraftRecording(session.key);
    signal.throwIfAborted();
    if (recording?.id !== session.recordingId) {
      throw new Error("Voice recording changed during transcription");
    }
    if (get(segments$) !== entries || recording.progress?.text !== undefined) {
      return;
    }
    const firstUnfinished = entries.findIndex(({ segment }) => {
      return (
        !segment ||
        recording.progress?.segments.find((saved) => {
          return saved.endSample === segment.endSample;
        })?.transcript === undefined
      );
    });
    if (firstUnfinished === -1) {
      return;
    }
    const retried = entries.slice(0, firstUnfinished);
    for (const entry of entries.slice(firstUnfinished)) {
      retried.push(
        createSegment(
          session,
          entry.segment,
          retried.at(-1),
          entry.totalDurationSeconds,
        ),
      );
    }
    set(segments$, retried);
  });

  return retry$;
}

/** Stable segment computeds form a chain; only the last result needs awaiting. */
export function createVoiceDraftTranscriptionSignals(
  options: VoiceDraftTranscriptionOptions,
) {
  const state = createTranscriptionState();
  const { session$, segments$, result$, wake$ } = state;
  const initialize$ = createInitialization(options, state);
  const append$ = createSegmentPreparation(options, state);
  const retry$ = createCheckpointRetry(state);
  const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(session$);
    const previous =
      current && !current.controller.signal.aborted && get(segments$).length > 0
        ? Promise.allSettled([get(result$)])
        : undefined;
    await set(initialize$, signal);
    await set(append$, true, signal);
    // Seal the tail immediately, even while its predecessor is requesting.
    // Only an already-started failed chain needs its unfinished suffix rebuilt.
    if (previous) {
      const [outcome] = await previous;
      signal.throwIfAborted();
      if (outcome?.status === "rejected" || !outcome?.value) {
        await set(retry$, signal);
      }
    }
    const result = await get(result$);
    signal.throwIfAborted();
    if (!result) {
      if (get(segments$).length > 0) {
        await set(openAudioInputQuotaRecovery$, signal);
      }
      return;
    }
    set(refreshAudioInputQuota$);
    return result.text;
  });

  const cancel$ = command(async ({ get, set }, signal: AbortSignal) => {
    const session = get(session$);
    session?.controller.abort();
    await Promise.allSettled([get(result$)]);
    signal.throwIfAborted();
    if (get(session$) === session) {
      set(session$, null);
      set(segments$, []);
    }
  });

  // This observer starts newly appended computeds and owns their background
  // lifetime. Request ordering is entirely expressed by predecessor dependencies.
  const watch$ = command(async ({ get, set }, signal: AbortSignal) => {
    while (!signal.aborted) {
      const wake = createDeferredPromise<void>(signal);
      set(wake$, wake);
      const notified = Promise.allSettled([wake.promise]);
      const last = get(segments$).at(-1);
      if (last) {
        const [outcome] = await Promise.allSettled([get(last.result$)]);
        signal.throwIfAborted();
        if (outcome?.status === "fulfilled") {
          if (outcome.value) {
            set(refreshAudioInputQuota$);
          } else {
            await set(openAudioInputQuotaRecovery$, signal);
          }
        }
      }
      await notified;
      signal.throwIfAborted();
    }
  });
  return { initialize$, append$, transcribe$, watch$, cancel$ };
}
