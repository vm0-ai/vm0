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
  OPENROUTER_VOICE_NO_SPEECH,
  polishLongVoiceTranscript,
  transcribeAndPolishVoice,
  transcribeVoice,
  type OpenRouterVoiceAudio,
  type OpenRouterVoiceTranscript,
} from "../external/openrouter-voice";
import { settle } from "../utils";

const MAX_CONCURRENT_VOICE_TRANSCRIPTIONS = 3;

interface VoiceDraftTranscriptionInput {
  readonly files: readonly File[];
  readonly longRecording: boolean;
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
  signal: AbortSignal,
  map: (value: T, signal: AbortSignal) => Promise<Result>,
): Promise<readonly Result[]> {
  const results: (Result | undefined)[] = Array.from({
    length: values.length,
  });
  const batchController = new AbortController();
  const batchSignal = AbortSignal.any([signal, batchController.signal]);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) {
        firstError = new Error("Voice transcription worker received no input");
        failed = true;
        batchController.abort(firstError);
        return;
      }
      const [outcome] = await Promise.allSettled([map(value, batchSignal)]);
      if (!outcome) {
        firstError = new Error("Voice transcription worker did not settle");
        failed = true;
        batchController.abort(firstError);
        return;
      }
      if (outcome.status === "rejected") {
        if (!failed) {
          firstError = outcome.reason;
          failed = true;
          batchController.abort(firstError);
        }
        return;
      }
      results[index] = outcome.value;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(maximumConcurrency, values.length) }, worker),
  );
  signal.throwIfAborted();
  if (failed) {
    throw firstError;
  }
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
    .filter((text) => {
      return text !== OPENROUTER_VOICE_NO_SPEECH;
    })
    .join(" ")
    .trim();
  if (transcript.length > VOICE_IO_POLISH_MAX_TEXT_CHARS) {
    throw new Error("Stitched voice transcript is invalid");
  }
  return transcript;
}

async function transcribeLongVoiceDraft(
  input: VoiceDraftTranscriptionInput,
  signal: AbortSignal,
): Promise<VoiceIoTranscribeResponse | null> {
  const pieces = await mapWithConcurrency(
    input.files,
    MAX_CONCURRENT_VOICE_TRANSCRIPTIONS,
    signal,
    async (file, workerSignal) => {
      const audio = await voiceAudio(file, workerSignal);
      const result = await transcribeVoice(
        audio,
        input.lastAssistantMessage,
        workerSignal,
      );
      if (result === null) {
        throw new Error("OpenRouter voice transcription is not configured");
      }
      return result;
    },
  );
  signal.throwIfAborted();
  const transcript = stitchTranscripts(pieces);
  if (!transcript) {
    return null;
  }
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
      input.longRecording
        ? transcribeLongVoiceDraft(input, requestSignal)
        : transcribeShortVoiceDraft(input, requestSignal),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    if (
      generated.value === null ||
      generated.value.transcript === OPENROUTER_VOICE_NO_SPEECH ||
      generated.value.polishedText === OPENROUTER_VOICE_NO_SPEECH
    ) {
      return { status: 204 as const, body: undefined };
    }
    return { status: 200 as const, body: generated.value };
  },
);
