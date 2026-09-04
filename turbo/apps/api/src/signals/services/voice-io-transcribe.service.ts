import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
import type { VoiceIoTranscribeResponse } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { command } from "ccstate";

import { notConfigured } from "../../lib/error";
import { requestSignal$ } from "../context/hono";
import {
  isLlmConfigured,
  OpenRouterRequestError,
} from "../external/openrouter";
import {
  polishLongVoiceTranscript,
  transcribeAndPolishVoice,
  transcribeVoice,
  type OpenRouterVoiceAudio,
  type OpenRouterVoiceTranscript,
} from "../external/openrouter-voice";
import { settle } from "../utils";

const MAX_CONCURRENT_VOICE_TRANSCRIPTIONS = 3;

export interface VoiceDraftTranscriptionInput {
  readonly files: readonly File[];
  readonly lastAssistantMessage?: string;
}

function transcriptionError<Status extends number>(
  status: Status,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } } as const;
}

function providerError(error: unknown) {
  if (
    error instanceof OpenRouterRequestError &&
    (error.status === 429 || error.status >= 500)
  ) {
    return transcriptionError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Voice draft transcription is temporarily unavailable",
    );
  }
  return transcriptionError(
    502,
    "VOICE_TRANSCRIPTION_FAILED",
    "Voice draft transcription failed to produce a usable response",
  );
}

async function voiceAudio(
  file: File,
  signal: AbortSignal,
): Promise<OpenRouterVoiceAudio> {
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  return {
    data: Buffer.from(bytes).toString("base64"),
    format: "wav",
  };
}

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  maximumConcurrency: number,
  map: (value: T) => Promise<Result>,
): Promise<readonly Result[]> {
  const results: (Result | undefined)[] = Array.from({
    length: values.length,
  });
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) {
        throw new Error("Voice transcription worker received no input");
      }
      results[index] = await map(value);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(maximumConcurrency, values.length) }, worker),
  );
  return results.map((result) => {
    if (result === undefined) {
      throw new Error("Voice transcription worker returned no result");
    }
    return result;
  });
}

function stitchTranscripts(
  pieces: readonly OpenRouterVoiceTranscript[],
): string {
  const transcript = pieces
    .map((piece) => {
      return piece.transcript.trim();
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!transcript || transcript.length > VOICE_IO_POLISH_MAX_TEXT_CHARS) {
    throw new Error("Stitched voice transcript is invalid");
  }
  return transcript;
}

async function transcribeLongVoiceDraft(
  input: VoiceDraftTranscriptionInput,
  signal: AbortSignal,
): Promise<VoiceIoTranscribeResponse> {
  const pieces = await mapWithConcurrency(
    input.files,
    MAX_CONCURRENT_VOICE_TRANSCRIPTIONS,
    async (file) => {
      const audio = await voiceAudio(file, signal);
      const result = await transcribeVoice(
        audio,
        input.lastAssistantMessage,
        signal,
      );
      if (result === null) {
        throw new Error("OpenRouter voice transcription is not configured");
      }
      return result;
    },
  );
  signal.throwIfAborted();
  const transcript = stitchTranscripts(pieces);
  const polished = await polishLongVoiceTranscript(
    transcript,
    input.lastAssistantMessage,
    signal,
  );
  if (polished === null) {
    throw new Error("OpenRouter voice transcription is not configured");
  }
  return {
    transcript,
    polishedText: polished.polishedText,
    language: polished.language,
  };
}

async function transcribeShortVoiceDraft(
  input: VoiceDraftTranscriptionInput,
  signal: AbortSignal,
): Promise<VoiceIoTranscribeResponse> {
  const file = input.files[0];
  if (!file) {
    throw new Error("Voice draft transcription requires one audio file");
  }
  const audio = await voiceAudio(file, signal);
  const result = await transcribeAndPolishVoice(
    audio,
    input.lastAssistantMessage,
    signal,
  );
  if (result === null) {
    throw new Error("OpenRouter voice transcription is not configured");
  }
  return result;
}

export const transcribeVoiceDraft$ = command(
  async ({ get }, input: VoiceDraftTranscriptionInput, signal: AbortSignal) => {
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    if (!isLlmConfigured()) {
      return notConfigured("Voice draft transcription is not configured");
    }

    const generated = await settle(
      input.files.length === 1
        ? transcribeShortVoiceDraft(input, requestSignal)
        : transcribeLongVoiceDraft(input, requestSignal),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    return { status: 200 as const, body: generated.value };
  },
);
