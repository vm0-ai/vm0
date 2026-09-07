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

interface VoiceDraftPreparation {
  readonly previous: readonly VoiceDraftTranscriptionSegment[];
  readonly segments$: Computed<
    Promise<readonly VoiceDraftTranscriptionSegment[]>
  >;
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
  const preparation$ = state<VoiceDraftPreparation | null>(null);
  const segments$ = computed(async (get) => {
    const preparation = get(preparation$);
    return preparation ? await get(preparation.segments$) : [];
  });
  const result$ = computed(async (get) => {
    const preparation = get(preparation$);
    if (!preparation) {
      return;
    }
    const prepared = get(preparation.segments$);
    const previous = preparation.previous.at(-1);
    // Preparation can fail while its predecessor is still transcribing. Keep
    // that request owned until it settles before propagating the preparation.
    await Promise.allSettled([
      prepared,
      ...(previous ? [get(previous.result$)] : []),
    ]);
    const last = (await prepared).at(-1);
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

  return { session$, preparation$, segments$, result$, wake$, notify$ };
}

type TranscriptionState = ReturnType<typeof createTranscriptionState>;

function createInitialization(
  options: VoiceDraftTranscriptionOptions,
  state: TranscriptionState,
) {
  const { session$, preparation$, result$ } = state;
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
    set(
      preparation$,
      restored.length > 0
        ? {
            previous: restored,
            segments$: computed(() => {
              return Promise.resolve(restored);
            }),
          }
        : null,
    );
  });

  return initialize$;
}

function prepareSegments(
  session: VoiceDraftTranscriptionSession,
  existing: readonly VoiceDraftTranscriptionSegment[],
  sampleCount: number,
  finished: boolean,
): VoiceDraftPreparation {
  const signal = session.controller.signal;
  return {
    previous: existing,
    segments$: computed(async () => {
      const entries = [...existing];
      let startSample = entries.at(-1)?.segment?.endSample ?? 0;
      const audio = await readVoiceDraftAudio(session.key, session.recordingId);
      signal.throwIfAborted();
      const totalDurationSeconds = sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE;
      while (startSample < sampleCount) {
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
      return entries;
    }),
  };
}

function createSegmentPreparation(
  options: VoiceDraftTranscriptionOptions,
  state: TranscriptionState,
) {
  const { session$, preparation$, segments$, notify$ } = state;
  // PCM writes wait only for local preparation, never HTTP. A preparation
  // failure remains on its computed while the recorder keeps saving audio.
  const append$ = command(
    async ({ get, set }, finished: boolean, signal: AbortSignal) => {
      let session = get(session$);
      if (!session) {
        return;
      }
      const current = get(preparation$);
      const prepared = await settle(get(segments$), signal);
      if (!prepared.ok) {
        return;
      }
      const existing = prepared.value;
      const last = existing.at(-1);
      if (isFinalSegment(last)) {
        return;
      }
      const recording = await readVoiceDraftRecording(session.key);
      signal.throwIfAborted();
      if (recording?.id !== session.recordingId) {
        throw new Error("Voice recording changed during transcription");
      }
      const startSample = last?.segment?.endSample ?? 0;
      if (
        !finished &&
        recording.sampleCount - startSample <
          VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS * VOICE_DRAFT_PCM_SAMPLE_RATE
      ) {
        return;
      }
      if (!session.context) {
        session = { ...session, context: set(options.readContext$) };
        set(session$, session);
      }
      if (get(preparation$) !== current) {
        return;
      }
      const preparation = prepareSegments(
        session,
        existing,
        recording.sampleCount,
        finished,
      );
      set(preparation$, preparation);
      set(notify$);
      if (finished) {
        await get(preparation.segments$);
        signal.throwIfAborted();
      } else {
        await settle(get(preparation.segments$), signal);
      }
    },
  );

  return append$;
}

function createCheckpointRetry(state: TranscriptionState) {
  const { session$, preparation$, segments$ } = state;
  const retry$ = command(async ({ get, set }, signal: AbortSignal) => {
    const session = get(session$);
    if (!session) {
      return;
    }
    const preparation = get(preparation$);
    if (!preparation) {
      return;
    }
    const prepared = await settle(get(segments$), signal);
    const entries = prepared.ok ? prepared.value : preparation.previous;
    const recording = await readVoiceDraftRecording(session.key);
    signal.throwIfAborted();
    if (recording?.id !== session.recordingId) {
      throw new Error("Voice recording changed during transcription");
    }
    if (
      get(preparation$) !== preparation ||
      recording.progress?.text !== undefined
    ) {
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
    const completed = firstUnfinished === -1 ? entries.length : firstUnfinished;
    const retried = entries.slice(0, completed);
    for (const entry of entries.slice(completed)) {
      retried.push(
        createSegment(
          session,
          entry.segment,
          retried.at(-1),
          entry.totalDurationSeconds,
        ),
      );
    }
    set(preparation$, {
      previous: retried,
      segments$: computed(() => {
        return Promise.resolve(retried);
      }),
    });
  });

  return retry$;
}

/** Stable segment computeds form a chain; only the last result needs awaiting. */
export function createVoiceDraftTranscriptionSignals(
  options: VoiceDraftTranscriptionOptions,
) {
  const state = createTranscriptionState();
  const { session$, preparation$, result$, wake$ } = state;
  const initialize$ = createInitialization(options, state);
  const append$ = createSegmentPreparation(options, state);
  const retry$ = createCheckpointRetry(state);
  const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(session$);
    const previous =
      current && !current.controller.signal.aborted && get(preparation$)
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
        await set(append$, true, signal);
      }
    }
    const result = await get(result$);
    signal.throwIfAborted();
    if (!result) {
      if (get(preparation$)) {
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
      set(preparation$, null);
    }
  });

  // This observer starts newly appended computeds and owns their background
  // lifetime. Request ordering is entirely expressed by predecessor dependencies.
  const watch$ = command(async ({ get, set }, signal: AbortSignal) => {
    while (!signal.aborted) {
      const wake = createDeferredPromise<void>(signal);
      set(wake$, wake);
      const notified = Promise.allSettled([wake.promise]);
      if (get(preparation$)) {
        const [outcome] = await Promise.allSettled([get(result$)]);
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
