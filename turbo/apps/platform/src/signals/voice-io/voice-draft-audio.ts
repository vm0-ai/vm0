import type { VoiceDraftSegment } from "../external/voice-draft-store";
import {
  decodeVoiceDraftPcmWav,
  encodeVoiceDraftPcmWav,
  VOICE_DRAFT_PCM_SAMPLE_RATE,
} from "./voice-draft-pcm";

const SEGMENT_SECONDS = 60;
const OVERLAP_SECONDS = 2;

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

/** The previous end marks new audio; overlap never advances recording time. */
export function nextVoiceDraftSegment(
  sampleCount: number,
  previousEndSample: number,
  finished: boolean,
): VoiceDraftSegment | null {
  if (sampleCount <= previousEndSample) {
    return null;
  }
  const startSample = Math.max(
    0,
    previousEndSample - OVERLAP_SECONDS * VOICE_DRAFT_PCM_SAMPLE_RATE,
  );
  const fullEndSample =
    startSample + SEGMENT_SECONDS * VOICE_DRAFT_PCM_SAMPLE_RATE;
  if (!finished && sampleCount < fullEndSample) {
    return null;
  }
  const endSample = Math.min(sampleCount, fullEndSample);
  return {
    startSample,
    endSample,
    final: finished && endSample === sampleCount,
  };
}

export async function voiceDraftSegmentFile(
  recording: Blob,
  segment: VoiceDraftSegment,
  signal: AbortSignal,
): Promise<File> {
  const samples = await recordingSamples(recording, signal);
  return new File(
    [
      encodeVoiceDraftPcmWav(
        samples.slice(segment.startSample, segment.endSample),
      ),
    ],
    `voice-draft-${String(segment.startSample)}.wav`,
    { type: "audio/wav" },
  );
}
