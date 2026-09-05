import { defaultModelFetcher } from "@ricky0123/vad-web/dist/default-model-fetcher";
import { SileroV5 } from "@ricky0123/vad-web/dist/models/v5";
import sileroModelUrl from "@ricky0123/vad-web/dist/silero_vad_v5.onnx?url";
import * as ort from "onnxruntime-web/wasm";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { VOICE_IO_TRANSCRIBE_LONG_RECORDING_SECONDS } from "@okouai/api-contracts/contracts/voice-io-transcribe";

import { bestEffort, withCleanup } from "../utils";
import {
  decodeVoiceDraftPcmWav,
  encodeVoiceDraftPcmWav,
  VOICE_DRAFT_PCM_SAMPLE_RATE,
} from "./voice-draft-pcm";

const CHUNK_MINIMUM_SECONDS = 45;
const CHUNK_TARGET_SECONDS = 60;
const CHUNK_HORIZON_SECONDS = 75;
const MINIMUM_PAUSE_SECONDS = 0.32;
const PREFERRED_PAUSE_SECONDS = 0.5;
const BOUNDARY_DISTANCE_WEIGHT = 6;
const SILERO_WINDOW_SAMPLES = 512;
const SILERO_POSITIVE_SPEECH_THRESHOLD = 0.5;
const SILERO_NEGATIVE_SPEECH_THRESHOLD = 0.35;
const SILERO_MINIMUM_SPEECH_SAMPLES = 4000;
const SILERO_MINIMUM_SILENCE_SAMPLES = 1600;

interface VoiceDraftSpeechRange {
  readonly startSample: number;
  readonly endSample: number;
}

interface VoiceDraftPause {
  readonly seconds: number;
  readonly duration: number;
  readonly depth: number;
}

interface VoiceDraftChunkRange {
  readonly startSample: number;
  readonly endSample: number;
}

function absoluteAssetUrl(value: string): string {
  return new URL(value, window.location.href).href;
}

function sileroSpeechRanges(
  probabilities: readonly number[],
  audioLengthSamples: number,
): readonly VoiceDraftSpeechRange[] {
  const ranges: VoiceDraftSpeechRange[] = [];
  let speechStart: number | undefined;
  let possibleEnd: number | undefined;
  for (let index = 0; index < probabilities.length; index += 1) {
    const probability = probabilities[index] ?? 0;
    const currentSample = SILERO_WINDOW_SAMPLES * index;
    if (probability >= SILERO_POSITIVE_SPEECH_THRESHOLD) {
      possibleEnd = undefined;
      speechStart ??= currentSample;
      continue;
    }
    if (
      probability >= SILERO_NEGATIVE_SPEECH_THRESHOLD ||
      speechStart === undefined
    ) {
      continue;
    }
    possibleEnd ??= currentSample;
    if (currentSample - possibleEnd < SILERO_MINIMUM_SILENCE_SAMPLES) {
      continue;
    }
    if (possibleEnd - speechStart > SILERO_MINIMUM_SPEECH_SAMPLES) {
      ranges.push({ startSample: speechStart, endSample: possibleEnd });
    }
    speechStart = undefined;
    possibleEnd = undefined;
  }
  if (
    speechStart !== undefined &&
    audioLengthSamples - speechStart > SILERO_MINIMUM_SPEECH_SAMPLES
  ) {
    ranges.push({ startSample: speechStart, endSample: audioLengthSamples });
  }
  return ranges;
}

function sileroPauses(
  ranges: readonly VoiceDraftSpeechRange[],
  probabilities: readonly number[],
): readonly VoiceDraftPause[] {
  const pauses: VoiceDraftPause[] = [];
  for (let index = 0; index + 1 < ranges.length; index += 1) {
    const current = ranges[index];
    const next = ranges[index + 1];
    if (!current || !next || next.startSample <= current.endSample) {
      continue;
    }
    const gapStart = current.endSample;
    const gapEnd = next.startSample;
    const firstWindow = Math.floor(gapStart / SILERO_WINDOW_SAMPLES);
    const lastWindow = Math.max(
      firstWindow + 1,
      Math.floor(gapEnd / SILERO_WINDOW_SAMPLES),
    );
    const gapProbabilities = probabilities.slice(
      Math.min(firstWindow, probabilities.length),
      Math.min(lastWindow, probabilities.length),
    );
    const meanSpeech =
      gapProbabilities.length === 0
        ? 0
        : gapProbabilities.reduce((total, probability) => {
            return total + probability;
          }, 0) / gapProbabilities.length;
    const middleSample = Math.floor((gapStart + gapEnd) / 2);
    pauses.push({
      seconds: middleSample / VOICE_DRAFT_PCM_SAMPLE_RATE,
      duration: (gapEnd - gapStart) / VOICE_DRAFT_PCM_SAMPLE_RATE,
      depth: (1 - meanSpeech) * 20,
    });
  }
  return pauses;
}

async function detectSileroPauses(
  samples: Float32Array,
  signal: AbortSignal,
): Promise<{
  readonly speechFound: boolean;
  readonly pauses: readonly VoiceDraftPause[];
}> {
  signal.throwIfAborted();
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: absoluteAssetUrl(ortWasmUrl) };
  const model = await SileroV5.new(ort, async () => {
    return await defaultModelFetcher(absoluteAssetUrl(sileroModelUrl));
  });
  return await withCleanup(
    (async () => {
      const probabilities: number[] = [];
      for (
        let offset = 0;
        offset < samples.length;
        offset += SILERO_WINDOW_SAMPLES
      ) {
        signal.throwIfAborted();
        const remaining = samples.length - offset;
        const frame =
          remaining >= SILERO_WINDOW_SAMPLES
            ? samples.slice(offset, offset + SILERO_WINDOW_SAMPLES)
            : new Float32Array(SILERO_WINDOW_SAMPLES);
        if (remaining < SILERO_WINDOW_SAMPLES) {
          frame.set(samples.subarray(offset));
        }
        probabilities.push((await model.process(frame)).isSpeech);
      }
      const ranges = sileroSpeechRanges(probabilities, samples.length);
      return {
        speechFound: ranges.length > 0,
        pauses: sileroPauses(ranges, probabilities),
      };
    })(),
    async () => {
      await bestEffort(model.release());
    },
  );
}

function boundaryScore(
  pause: VoiceDraftPause,
  relativeSeconds: number,
): number {
  const preferredBonus = pause.duration >= PREFERRED_PAUSE_SECONDS ? 3 : 0;
  const duration = Math.min(2, pause.duration) * 4;
  const depth = Math.min(20, pause.depth) / 10;
  const window = Math.max(1, CHUNK_HORIZON_SECONDS - CHUNK_MINIMUM_SECONDS);
  const distance =
    (BOUNDARY_DISTANCE_WEIGHT *
      Math.abs(relativeSeconds - CHUNK_TARGET_SECONDS)) /
    window;
  return preferredBonus + duration + depth - distance;
}

function bestBoundary(
  pauses: readonly VoiceDraftPause[],
  startSeconds: number,
): number | undefined {
  const eligible = pauses
    .map((pause) => {
      return { pause, relativeSeconds: pause.seconds - startSeconds };
    })
    .filter(({ pause, relativeSeconds }) => {
      return (
        pause.duration >= MINIMUM_PAUSE_SECONDS &&
        relativeSeconds >= CHUNK_MINIMUM_SECONDS
      );
    });
  const preferred = eligible.filter(({ relativeSeconds }) => {
    return relativeSeconds <= CHUNK_HORIZON_SECONDS;
  });
  if (preferred.length > 0) {
    return preferred.reduce((best, candidate) => {
      return boundaryScore(candidate.pause, candidate.relativeSeconds) >
        boundaryScore(best.pause, best.relativeSeconds)
        ? candidate
        : best;
    }).pause.seconds;
  }
  return eligible.reduce<number | undefined>((earliest, candidate) => {
    if (earliest === undefined || candidate.pause.seconds < earliest) {
      return candidate.pause.seconds;
    }
    return earliest;
  }, undefined);
}

export function voiceDraftChunkRanges(
  sampleCount: number,
  pauses: readonly VoiceDraftPause[],
): readonly VoiceDraftChunkRange[] {
  const durationSeconds = sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE;
  if (durationSeconds <= VOICE_IO_TRANSCRIBE_LONG_RECORDING_SECONDS) {
    return [{ startSample: 0, endSample: sampleCount }];
  }

  const ranges: VoiceDraftChunkRange[] = [];
  let startSample = 0;
  while (startSample < sampleCount) {
    const remainingSamples = sampleCount - startSample;
    if (
      remainingSamples <=
      CHUNK_TARGET_SECONDS * VOICE_DRAFT_PCM_SAMPLE_RATE
    ) {
      ranges.push({ startSample, endSample: sampleCount });
      break;
    }
    const startSeconds = startSample / VOICE_DRAFT_PCM_SAMPLE_RATE;
    const boundarySeconds = bestBoundary(pauses, startSeconds);
    if (boundarySeconds === undefined) {
      ranges.push({ startSample, endSample: sampleCount });
      break;
    }
    const endSample = Math.round(boundarySeconds * VOICE_DRAFT_PCM_SAMPLE_RATE);
    const finalSeconds =
      (sampleCount - endSample) / VOICE_DRAFT_PCM_SAMPLE_RATE;
    if (endSample <= startSample || finalSeconds < CHUNK_MINIMUM_SECONDS) {
      ranges.push({ startSample, endSample: sampleCount });
      break;
    }
    ranges.push({ startSample, endSample });
    startSample = endSample;
  }
  return ranges;
}

async function pausesForSamples(
  samples: Float32Array,
  signal: AbortSignal,
): Promise<readonly VoiceDraftPause[]> {
  const detected = await detectSileroPauses(samples, signal);
  signal.throwIfAborted();
  return detected.speechFound ? detected.pauses : [];
}

async function recordingSamples(
  recording: Blob,
  signal: AbortSignal,
): Promise<Float32Array> {
  const encoded = await recording.arrayBuffer();
  signal.throwIfAborted();
  const samples = decodeVoiceDraftPcmWav(encoded);
  if (!samples) {
    throw new Error("Voice draft PCM recording was invalid");
  }
  return samples;
}

export async function prepareVoiceDraftAudio(
  recording: Blob,
  signal: AbortSignal,
): Promise<readonly File[]> {
  const samples = await recordingSamples(recording, signal);
  if (samples.length === 0) {
    throw new Error("Voice recording did not contain audio samples");
  }
  const durationSeconds = samples.length / VOICE_DRAFT_PCM_SAMPLE_RATE;
  const pauses =
    durationSeconds > VOICE_IO_TRANSCRIBE_LONG_RECORDING_SECONDS
      ? await pausesForSamples(samples, signal)
      : [];
  signal.throwIfAborted();
  const ranges = voiceDraftChunkRanges(samples.length, pauses);
  return ranges.map((range, index) => {
    const blob = encodeVoiceDraftPcmWav(
      samples.slice(range.startSample, range.endSample),
    );
    return new File([blob], `voice-draft-${String(index + 1)}.wav`, {
      type: "audio/wav",
    });
  });
}
