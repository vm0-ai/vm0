import {
  command,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import {
  VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS,
  voiceIoTranscribeContract,
  type VoiceIoTranscribeContext,
  type VoiceIoTranscribeSegmentResponse,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  readVoiceDraftRecording,
  readVoiceDraftAudio,
  saveVoiceDraftProgress,
  type VoiceDraftProgress,
  type VoiceDraftRecordingRecord,
  type VoiceDraftSegment,
} from "../external/voice-draft-store.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  withCleanup,
} from "../utils.ts";
import {
  nextVoiceDraftSegment,
  voiceDraftSegmentFile,
} from "./voice-draft-audio.ts";
import { VOICE_DRAFT_PCM_SAMPLE_RATE } from "./voice-draft-pcm.ts";
import {
  openAudioInputQuotaRecovery$,
  refreshAudioInputQuota$,
} from "./voice-io-stt.ts";

interface VoiceDraftTranscriptionOptions {
  readonly storageKey$: Computed<Promise<string>>;
  readonly recordingActive$: Computed<boolean>;
  readonly readContext$: Command<VoiceIoTranscribeContext, []>;
}

interface VoiceDraftWork {
  readonly progress: VoiceDraftProgress;
  readonly segment?: VoiceDraftSegment;
  readonly final: boolean;
  readonly body: FormData;
}

/** Persist the exact audio boundary before sending a recoverable request. */
async function prepareVoiceDraftWork(
  key: string,
  recording: VoiceDraftRecordingRecord,
  saved: VoiceDraftProgress,
  finished: boolean,
  signal: AbortSignal,
): Promise<VoiceDraftWork | "" | undefined> {
  let progress = saved;
  let segment = progress.segments.find((item) => {
    return item.transcript === undefined;
  });
  const startSample = progress.segments.at(-1)?.endSample ?? 0;
  const remaining = recording.sampleCount - startSample;
  if (
    !segment &&
    !finished &&
    remaining <
      VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS * VOICE_DRAFT_PCM_SAMPLE_RATE
  ) {
    return;
  }
  const previousTranscript = progress.segments
    .map((item) => {
      return item.transcript ?? "";
    })
    .filter(Boolean)
    .join(" ");
  if (!segment && remaining === 0 && !previousTranscript) {
    return finished ? "" : undefined;
  }
  const blob = await readVoiceDraftAudio(key, recording.id);
  signal.throwIfAborted();
  if (!segment && remaining > 0) {
    segment =
      (await nextVoiceDraftSegment(blob, startSample, finished, signal)) ??
      undefined;
    if (!segment) {
      return;
    }
    progress = {
      ...progress,
      revision: progress.revision + 1,
      segments: [...progress.segments, segment],
    };
    await saveVoiceDraftProgress(key, recording.id, progress);
    signal.throwIfAborted();
  }
  const final = segment?.final ?? finished;
  const body = new FormData();
  if (segment) {
    body.append("file", await voiceDraftSegmentFile(blob, segment, signal));
  }
  body.append(
    "options",
    JSON.stringify({
      previousTranscript,
      final,
      totalDurationSeconds: recording.sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE,
    }),
  );
  if (progress.context.lastAssistantMessage) {
    body.append("lastAssistantMessage", progress.context.lastAssistantMessage);
  }
  if (progress.context.editorContext) {
    body.append(
      "editorContext",
      JSON.stringify(progress.context.editorContext),
    );
  }
  return { progress, segment, final, body };
}

function completedVoiceDraftText(
  final: boolean,
  response: VoiceIoTranscribeSegmentResponse | undefined,
): string | undefined {
  if (!final) {
    return;
  }
  if (!response) {
    return "";
  }
  if (!response.polishedText?.trim()) {
    throw new Error("Final voice transcription returned no polished text");
  }
  return response.polishedText;
}

function createVoiceDraftProcessor(
  options: VoiceDraftTranscriptionOptions,
  pausedRecording$: State<string | null>,
) {
  return command(
    async (
      { get, set },
      finished: boolean,
      signal: AbortSignal,
    ): Promise<string | undefined> => {
      const key = await get(options.storageKey$);
      signal.throwIfAborted();
      const initial = await readVoiceDraftRecording(key);
      signal.throwIfAborted();
      if (!initial) {
        return;
      }
      while (true) {
        const recording = await readVoiceDraftRecording(key);
        signal.throwIfAborted();
        if (recording?.id !== initial.id) {
          throw new Error("Voice recording changed during transcription");
        }
        const progress: VoiceDraftProgress = recording.progress ?? {
          revision: 0,
          context: set(options.readContext$),
          segments: [],
        };
        if (progress.text !== undefined) {
          return progress.text;
        }
        const work = await prepareVoiceDraftWork(
          key,
          recording,
          progress,
          finished,
          signal,
        );
        signal.throwIfAborted();
        if (work === undefined || typeof work === "string") {
          return work;
        }
        const result = await accept(
          get(apiClient$)(voiceIoTranscribeContract).segment({
            body: work.body,
            fetchOptions: { signal },
          }),
          [200, 204, 402, 429],
          signal,
        );
        signal.throwIfAborted();
        if (result.status === 402 || result.status === 429) {
          set(pausedRecording$, recording.id);
          await set(openAudioInputQuotaRecovery$, signal);
          return;
        }
        const transcript = result.status === 200 ? result.body.transcript : "";
        const text = completedVoiceDraftText(
          work.final,
          result.status === 200 ? result.body : undefined,
        );
        const segmentEnd = work.segment?.endSample;
        await saveVoiceDraftProgress(key, recording.id, {
          ...work.progress,
          revision: work.progress.revision + 1,
          segments: work.progress.segments.map((item) => {
            return item.endSample === segmentEnd
              ? { ...item, transcript }
              : item;
          }),
          ...(text === undefined ? {} : { text }),
        });
        signal.throwIfAborted();
        set(refreshAudioInputQuota$);
        if (work.final) {
          return text;
        }
      }
    },
  );
}

/** One serial consumer, independent of the recorder's ordered PCM writes. */
export function createVoiceDraftTranscriptionSignals(
  options: VoiceDraftTranscriptionOptions,
) {
  const wake$ = state<ReturnType<typeof createDeferredPromise<void>> | null>(
    null,
  );
  const pending$ = state<Promise<
    PromiseSettledResult<string | undefined>[]
  > | null>(null);
  const backgroundController$ = state<AbortController | null>(null);
  const pausedRecording$ = state<string | null>(null);
  const notify$ = command(({ get }) => {
    const wake = get(wake$);
    if (wake && !wake.settled()) {
      wake.resolve();
    }
  });

  const process$ = createVoiceDraftProcessor(options, pausedRecording$);

  const transcribe$ = command(
    async ({ get, set }, finished: boolean, signal: AbortSignal) => {
      // Register ownership before any processing can make synchronous progress.
      while (get(pending$)) {
        await get(pending$);
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      const start = createDeferredPromise<void>(signal);
      const processing = (async () => {
        await start.promise;
        signal.throwIfAborted();
        return await set(process$, finished, signal);
      })();
      set(pending$, Promise.allSettled([processing]));
      if (!start.settled()) {
        start.resolve();
      }
      return await withCleanup(processing, () => {
        set(pending$, null);
      });
    },
  );

  const cancel$ = command(async ({ get }, signal: AbortSignal) => {
    get(backgroundController$)?.abort();
    await get(pending$);
    signal.throwIfAborted();
  });

  const watch$ = command(async ({ get, set }, signal: AbortSignal) => {
    while (!signal.aborted) {
      // Subscribe before inspecting the queue so a PCM commit cannot be missed.
      const wake = createDeferredPromise<void>(signal);
      set(wake$, wake);
      const notified = Promise.allSettled([wake.promise]);
      if (get(options.recordingActive$)) {
        const key = await get(options.storageKey$);
        signal.throwIfAborted();
        const recording = await readVoiceDraftRecording(key);
        signal.throwIfAborted();
        if (recording && recording.id !== get(pausedRecording$)) {
          const controller = createChildAbortController(signal);
          set(backgroundController$, controller);
          await withCleanup(
            (async () => {
              const [outcome] = await Promise.allSettled([
                set(transcribe$, false, controller.signal),
              ]);
              signal.throwIfAborted();
              if (
                outcome?.status === "rejected" &&
                !controller.signal.aborted
              ) {
                // Keep recording; Stop/Retry resumes this segment explicitly.
                set(pausedRecording$, recording.id);
              }
            })(),
            () => {
              controller.abort();
              set(backgroundController$, null);
            },
          );
        }
      }
      await notified;
      signal.throwIfAborted();
    }
  });
  return { notify$, transcribe$, watch$, cancel$ };
}
