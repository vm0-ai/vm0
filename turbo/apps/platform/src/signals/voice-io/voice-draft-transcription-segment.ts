import { computed, type Computed } from "ccstate";
import {
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
  type VoiceDraftSegment,
} from "../external/voice-draft-store.ts";
import { voiceDraftSegmentFile } from "./voice-draft-audio.ts";

interface VoiceDraftTranscriptionResult {
  readonly transcript: string;
  readonly text?: string;
}

type SegmentResult = Computed<
  Promise<VoiceDraftTranscriptionResult | undefined>
>;

interface SegmentOptions {
  readonly key: string;
  readonly recordingId: string;
  readonly context: VoiceIoTranscribeContext;
  readonly segment?: VoiceDraftSegment;
  readonly totalDurationSeconds: number;
  readonly previous$?: SegmentResult;
}

async function segmentBody(
  options: SegmentOptions,
  context: VoiceIoTranscribeContext,
  previousTranscript: string,
  signal: AbortSignal,
): Promise<FormData> {
  const body = new FormData();
  if (options.segment) {
    const audio = await readVoiceDraftAudio(options.key, options.recordingId);
    signal.throwIfAborted();
    body.append(
      "file",
      await voiceDraftSegmentFile(audio, options.segment, signal),
    );
  }
  body.append(
    "options",
    JSON.stringify({
      previousTranscript,
      final: options.segment?.final ?? true,
      totalDurationSeconds: options.totalDurationSeconds,
    }),
  );
  if (context.lastAssistantMessage) {
    body.append("lastAssistantMessage", context.lastAssistantMessage);
  }
  if (context.editorContext) {
    body.append("editorContext", JSON.stringify(context.editorContext));
  }
  return body;
}

function completedText(
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

/** Each segment owns its request and waits for the preceding checkpoint. */
export function createVoiceDraftSegmentResult(
  options: SegmentOptions,
  signal: AbortSignal,
): SegmentResult {
  const { key, recordingId, segment } = options;
  const final = segment?.final ?? true;
  const segmentEnd = segment?.endSample;
  return computed(async (get) => {
    const previous = options.previous$
      ? await get(options.previous$)
      : { transcript: "" };
    signal.throwIfAborted();
    // An exhausted quota stops the rest of the chain until an explicit retry.
    if (!previous) {
      return;
    }
    const recording = await readVoiceDraftRecording(key);
    signal.throwIfAborted();
    if (recording?.id !== recordingId) {
      throw new Error("Voice recording changed during transcription");
    }
    let progress = recording.progress ?? {
      revision: 0,
      context: options.context,
      segments: [],
    };
    if (progress.text !== undefined) {
      return { transcript: previous.transcript, text: progress.text };
    }
    const saved = progress.segments.find((item) => {
      return item.endSample === segmentEnd;
    });
    if (saved?.transcript !== undefined) {
      return {
        transcript: [previous.transcript, saved.transcript]
          .filter(Boolean)
          .join(" "),
      };
    }
    if (!segment && !previous.transcript) {
      return { transcript: "", text: "" };
    }
    if (segment && !saved) {
      progress = {
        ...progress,
        revision: progress.revision + 1,
        segments: [...progress.segments, segment],
      };
      // Persist the boundary before HTTP so retries use the same audio bytes.
      await saveVoiceDraftProgress(key, recordingId, progress);
      signal.throwIfAborted();
    }
    const body = await segmentBody(
      options,
      progress.context,
      previous.transcript,
      signal,
    );
    const result = await accept(
      get(apiClient$)(voiceIoTranscribeContract).segment({
        body,
        fetchOptions: { signal },
      }),
      [200, 204, 402, 429],
      signal,
    );
    if (result.status === 402 || result.status === 429) {
      return;
    }
    const transcript = result.status === 200 ? result.body.transcript : "";
    const text = completedText(
      final,
      result.status === 200 ? result.body : undefined,
    );
    await saveVoiceDraftProgress(key, recordingId, {
      ...progress,
      revision: progress.revision + 1,
      segments: progress.segments.map((item) => {
        return item.endSample === segmentEnd ? { ...item, transcript } : item;
      }),
      ...(text === undefined ? {} : { text }),
    });
    signal.throwIfAborted();
    return {
      transcript: [previous.transcript, transcript].filter(Boolean).join(" "),
      ...(text === undefined ? {} : { text }),
    };
  });
}
