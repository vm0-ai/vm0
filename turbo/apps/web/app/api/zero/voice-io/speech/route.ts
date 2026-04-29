import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { isApiError } from "@vm0/api-services/errors";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { checkOrgCredits } from "../../../../../src/lib/zero/credit/check-org-credits";
import { processOrgUsageEvents } from "../../../../../src/lib/zero/credit/usage-event-service";
import { uploadS3Buffer } from "../../../../../src/lib/infra/s3/s3-client";
import { buildFileUrl } from "../../../../../src/lib/zero/uploads/file-url";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";

export const runtime = "nodejs";

const log = logger("api:zero:voice-io:speech");

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const MODEL = "gpt-4o-mini-tts";
const USAGE_KIND = "audio";
const USAGE_PROVIDER = MODEL;
const USAGE_CATEGORY = "output_audio_seconds";
const RESPONSE_FORMAT = "wav";
const CONTENT_TYPE = "audio/wav";
const MAX_INPUT_TOKENS = 2000;

const VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

function errorResponse(message: string, code: string, status: number) {
  return NextResponse.json({ error: { message, code } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return text;
}

function isRiffWav(bytes: Uint8Array): boolean {
  return readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WAVE";
}

type WavFormat = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

function readWavFormat(
  view: DataView,
  chunkStart: number,
  byteLength: number,
): WavFormat | null {
  if (chunkStart + 16 > byteLength) return null;
  return {
    channels: view.getUint16(chunkStart + 2, true),
    sampleRate: view.getUint32(chunkStart + 4, true),
    bitsPerSample: view.getUint16(chunkStart + 14, true),
  };
}

function readStandardWavFormat(view: DataView): WavFormat {
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
  };
}

function hasUsableWavFormat(format: WavFormat): boolean {
  return (
    format.channels > 0 && format.sampleRate > 0 && format.bitsPerSample > 0
  );
}

function parseWavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null;
  if (!isRiffWav(bytes)) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | null = null;
  let dataOffset: number | null = null;

  // Walk chunks to find fmt info and the start of the data chunk
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkId === "fmt " && chunkSize >= 16) {
      format = readWavFormat(view, chunkStart, bytes.byteLength) ?? format;
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
    }

    if (chunkEnd > bytes.byteLength) break;

    offset = chunkEnd + (chunkSize % 2);
  }

  // If we couldn't find fmt chunk via walking, try standard WAV header position
  // (24 kHz, 16-bit, mono is what gpt-4o-mini-tts outputs)
  format = format ?? readStandardWavFormat(view);
  if (!hasUsableWavFormat(format)) return null;

  // Estimate audio data size from total bytes rather than trusting the data chunk header.
  // If we found the data chunk, use bytes after it; otherwise subtract the standard 44-byte header.
  const audioBytes =
    dataOffset !== null ? bytes.byteLength - dataOffset : bytes.byteLength - 44;

  if (audioBytes <= 0) return null;

  const bytesPerSecond =
    format.sampleRate * format.channels * (format.bitsPerSample / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return Math.max(1, Math.ceil(audioBytes / bytesPerSecond));
}

async function loadSpeechPricing() {
  const [pricing] = await globalThis.services.db
    .select({
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, USAGE_KIND),
        eq(usagePricing.provider, USAGE_PROVIDER),
        eq(usagePricing.category, USAGE_CATEGORY),
      ),
    )
    .limit(1);
  return pricing ?? null;
}

async function handlePost(request: Request): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { requiredCapability: "file:write" },
  );
  if (!authCtx) {
    return errorResponse("Not authenticated", "UNAUTHORIZED", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", "BAD_REQUEST", 400);
  }
  if (!isRecord(body)) {
    return errorResponse("Invalid JSON body", "BAD_REQUEST", 400);
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) {
    return errorResponse("text is required", "BAD_REQUEST", 400);
  }

  const voice = typeof body.voice === "string" ? body.voice : "marin";
  if (!VOICES.has(voice)) {
    return errorResponse(`Unsupported voice: ${voice}`, "BAD_REQUEST", 400);
  }

  const instructions =
    typeof body.instructions === "string" && body.instructions.trim().length > 0
      ? body.instructions.trim()
      : undefined;
  const tokenCount = encode(`${instructions ?? ""}\n${text}`).length;
  if (tokenCount > MAX_INPUT_TOKENS) {
    return errorResponse(
      `text and instructions exceed ${MAX_INPUT_TOKENS} input tokens`,
      "BAD_REQUEST",
      400,
    );
  }

  const { org } = await resolveOrg(authCtx);
  const db = globalThis.services.db;
  await checkOrgCredits(org.orgId, authCtx.userId, db);

  const pricing = await loadSpeechPricing();
  if (!pricing) {
    return errorResponse(
      "Audio generation pricing is not configured",
      "NOT_CONFIGURED",
      503,
    );
  }

  const openaiResponse = await fetch(OPENAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env().OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      voice,
      input: text,
      ...(instructions ? { instructions } : {}),
      response_format: RESPONSE_FORMAT,
    }),
    signal: request.signal,
  });

  if (!openaiResponse.ok) {
    const errorBody = await openaiResponse.text();
    log.error("OpenAI speech request failed", {
      status: openaiResponse.status,
      body: errorBody,
    });
    return errorResponse(
      "Speech generation failed",
      "INTERNAL_SERVER_ERROR",
      500,
    );
  }

  const audioBytes = new Uint8Array(await openaiResponse.arrayBuffer());
  if (audioBytes.byteLength === 0) {
    return errorResponse(
      "Model returned empty audio",
      "NO_AUDIO_RETURNED",
      502,
    );
  }

  const durationSeconds = parseWavDurationSeconds(audioBytes);
  if (durationSeconds === null) {
    log.error("Unable to parse generated WAV duration", {
      byteLength: audioBytes.byteLength,
    });
    return errorResponse(
      "Could not determine generated audio duration",
      "AUDIO_DURATION_UNKNOWN",
      502,
    );
  }

  const expectedCredits = Math.ceil(
    (durationSeconds * pricing.unitPrice) / pricing.unitSize,
  );

  const fileId = randomUUID();
  const filename = `voice-${fileId.slice(0, 8)}.wav`;
  const s3Key = `uploads/${authCtx.userId}/${fileId}/${filename}`;
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  await uploadS3Buffer(bucket, s3Key, Buffer.from(audioBytes), CONTENT_TYPE);
  const url = buildFileUrl(authCtx.userId, fileId, filename);

  await db.insert(usageEvent).values({
    runId: null,
    idempotencyKey: randomUUID(),
    orgId: org.orgId,
    userId: authCtx.userId,
    kind: USAGE_KIND,
    provider: USAGE_PROVIDER,
    category: USAGE_CATEGORY,
    quantity: durationSeconds,
  });
  await processOrgUsageEvents(org.orgId);

  return NextResponse.json({
    id: fileId,
    filename,
    contentType: CONTENT_TYPE,
    size: audioBytes.byteLength,
    url,
    durationSeconds,
    creditsCharged: expectedCredits,
    model: MODEL,
    voice,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handlePost(request);
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    throw error;
  }
}
