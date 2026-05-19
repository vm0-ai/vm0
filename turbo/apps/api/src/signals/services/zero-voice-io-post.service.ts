import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import { orgTierSchema, type OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { and, eq, inArray, sql } from "drizzle-orm";

import { buildArtifactKey, buildFileUrl } from "../../lib/file-url";
import { env } from "../../lib/env";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { putS3Object } from "../external/s3";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

export const OPENAI_AUDIO_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
export const OPENAI_AUDIO_TRANSCRIPTIONS_URL =
  "https://api.openai.com/v1/audio/transcriptions";
export const VOICE_IO_TTS_MODEL = "gpt-4o-mini-tts";
export const VOICE_IO_STT_MODEL = "gpt-4o-mini-transcribe";
export const SPEECH_CONTENT_TYPE = "audio/wav";
export const SPEECH_RESPONSE_FORMAT = "wav";
export const TTS_RESPONSE_FORMAT = "pcm";
export const TTS_CONTENT_TYPE = "application/octet-stream";
export const TTS_MAX_TEXT_LENGTH = 4096;
export const SPEECH_MAX_INPUT_TOKENS = 2000;
export const MAX_STT_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_STT_REQUEST_DURATION_SECONDS = 5 * 60;

const USAGE_KIND = "audio";
const USAGE_PROVIDER = VOICE_IO_TTS_MODEL;
const USAGE_CATEGORY = "output_audio_seconds";
const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";
const DAILY_RATE_KEY_PREFIX = "audio_input_daily";
const DAILY_DURATION_KEY_PREFIX = "audio_input_dur";
const MIN_SPEECH_BITRATE_BPS = 8000;
const MAX_DURATION_READ_BYTES = 4096;
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3] as const;

const DAILY_RATE_LIMITS: Readonly<Record<OrgTier, number>> = {
  free: 10,
  pro: 300,
  team: 500,
};

const DAILY_DURATION_LIMITS: Readonly<Record<OrgTier, number>> = {
  free: 10 * 60,
  pro: 200 * 60,
  team: 500 * 60,
};

const ALLOWED_STT_MIME_TYPES = [
  "audio/webm",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mpga",
] as const;

const SPEECH_VOICES = [
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
] as const;

type ErrorStatus = 400 | 402 | 403 | 429 | 500 | 502 | 503;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

interface QuotaErrorBody extends ErrorBody {
  readonly quota: {
    readonly count: number;
    readonly limit: number | null;
  };
}

type ErrorResponse = {
  readonly status: ErrorStatus;
  readonly body: ErrorBody | QuotaErrorBody;
};

interface SttDailyPolicy {
  readonly orgTier: OrgTier;
  readonly rateKey: string;
  readonly durationKey: string;
  readonly durationSeconds: number;
}

export interface SpeechPricing {
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface RecordedSpeech {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly durationSeconds: number;
  readonly creditsCharged: number;
  readonly model: string;
  readonly voice: string;
}

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

interface WavFormat {
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

export function badRequest(message: string, code = "BAD_REQUEST") {
  return { status: 400 as const, body: errorBody(message, code) };
}

export function forbidden(message: string) {
  return { status: 403 as const, body: errorBody(message, "FORBIDDEN") };
}

export function internalError(message: string) {
  return {
    status: 500 as const,
    body: errorBody(message, "INTERNAL_SERVER_ERROR"),
  };
}

export function badGateway(message: string, code: string) {
  return { status: 502 as const, body: errorBody(message, code) };
}

export function serviceUnavailable(message: string, code: string) {
  return { status: 503 as const, body: errorBody(message, code) };
}

export function insufficientCredits() {
  return {
    status: 402 as const,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

function quotaError(
  status: 402 | 429,
  message: string,
  code: string,
  count: number,
  limit: number | null,
) {
  return {
    status,
    body: {
      error: { message, code },
      quota: { count, limit },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTranscriptionBody(
  value: unknown,
): value is { readonly text: string } {
  return isRecord(value) && typeof value.text === "string";
}

export function isAllowedSttMimeType(value: string): boolean {
  return ALLOWED_STT_MIME_TYPES.some((mimeType) => {
    return mimeType === value;
  });
}

export function isSpeechVoice(value: string): boolean {
  return SPEECH_VOICES.some((voice) => {
    return voice === value;
  });
}

export function sttDailyRateKey(date: Date = nowDate()): string {
  return `${DAILY_RATE_KEY_PREFIX}_${date.toISOString().slice(0, 10)}`;
}

export function sttDailyDurationKey(date: Date = nowDate()): string {
  return `${DAILY_DURATION_KEY_PREFIX}_${date.toISOString().slice(0, 10)}`;
}

function estimatedSpeechCredits(
  durationSeconds: number,
  pricing: SpeechPricing,
): number {
  return Math.ceil((durationSeconds * pricing.unitPrice) / pricing.unitSize);
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

function readSpeechWavFormat(
  view: DataView,
  chunkStart: number,
  byteLength: number,
): WavFormat | null {
  if (chunkStart + 16 > byteLength) {
    return null;
  }
  return {
    channels: view.getUint16(chunkStart + 2, true),
    sampleRate: view.getUint32(chunkStart + 4, true),
    bitsPerSample: view.getUint16(chunkStart + 14, true),
  };
}

function readStandardSpeechWavFormat(view: DataView): WavFormat {
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

export function parseSpeechWavDurationSeconds(
  bytes: Uint8Array,
): number | null {
  if (bytes.byteLength < 44) {
    return null;
  }
  if (!isRiffWav(bytes)) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | null = null;
  let dataOffset: number | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkId === "fmt " && chunkSize >= 16) {
      format =
        readSpeechWavFormat(view, chunkStart, bytes.byteLength) ?? format;
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
    }

    if (chunkEnd > bytes.byteLength) {
      break;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  format = format ?? readStandardSpeechWavFormat(view);
  if (!hasUsableWavFormat(format)) {
    return null;
  }

  const audioBytes =
    dataOffset !== null ? bytes.byteLength - dataOffset : bytes.byteLength - 44;
  if (audioBytes <= 0) {
    return null;
  }

  const bytesPerSecond =
    format.sampleRate * format.channels * (format.bitsPerSample / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return null;
  }
  return Math.max(1, Math.ceil(audioBytes / bytesPerSecond));
}

function sttWavDuration(buf: Uint8Array): number | null {
  if (buf.length < 44) {
    return null;
  }
  if (
    buf[0] !== 0x52 ||
    buf[1] !== 0x49 ||
    buf[2] !== 0x46 ||
    buf[3] !== 0x46
  ) {
    return null;
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const sampleRate = view.getUint32(24, true);
  const numChannels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);

  if (sampleRate === 0 || numChannels === 0 || bitsPerSample === 0) {
    return null;
  }
  const bytesPerSecond = (sampleRate * numChannels * bitsPerSample) / 8;
  if (bytesPerSecond === 0) {
    return null;
  }
  return Math.ceil(dataSize / bytesPerSecond);
}

function estimateDurationFromSize(fileSize: number): number {
  return Math.ceil(fileSize / (MIN_SPEECH_BITRATE_BPS / 8));
}

function vintLen(firstByte: number): number | null {
  let mask = 0x80;
  for (let i = 1; i <= 8; i++) {
    if (firstByte & mask) {
      return i;
    }
    mask >>= 1;
  }
  return null;
}

function readVint(
  buf: Uint8Array,
  pos: number,
): { readonly value: number; readonly next: number } | null {
  if (pos >= buf.length) {
    return null;
  }
  const len = vintLen(buf[pos] ?? 0);
  if (len === null || pos + len > buf.length) {
    return null;
  }

  let value = (buf[pos] ?? 0) & ((1 << (8 - len)) - 1);
  for (let i = 1; i < len; i++) {
    value = (value << 8) | (buf[pos + i] ?? 0);
  }
  return { value, next: pos + len };
}

function readDurationFloat(
  buf: Uint8Array,
  valuePos: number,
  valueSize: number,
): number | null {
  if (valuePos + valueSize > buf.length) {
    return null;
  }
  const view = new DataView(buf.buffer, buf.byteOffset + valuePos, valueSize);
  let value: number;
  if (valueSize === 8) {
    value = view.getFloat64(0, false);
  } else if (valueSize === 4) {
    value = view.getFloat32(0, false);
  } else {
    return null;
  }
  if (Number.isNaN(value) || value < 0) {
    return null;
  }
  return value;
}

function readTimecodeScale(
  buf: Uint8Array,
  valuePos: number,
  valueSize: number,
): number | null {
  if (valuePos + valueSize > buf.length) {
    return null;
  }
  if (valueSize <= 0 || valueSize > 8) {
    return null;
  }
  let scale = 0;
  for (let i = 0; i < valueSize; i++) {
    scale = scale * 256 + (buf[valuePos + i] ?? 0);
  }
  return scale > 0 ? scale : null;
}

function findDurationInInfo(
  buf: Uint8Array,
  dataStart: number,
  dataLen: number,
): number | null {
  const end = Math.min(dataStart + dataLen, buf.length);
  let pos = dataStart;
  let durationInScale: number | null = null;
  let timecodeScaleNs = DEFAULT_TIMECODE_SCALE_NS;

  while (pos + 2 <= end) {
    const idLen = vintLen(buf[pos] ?? 0);
    if (idLen === null || pos + idLen > end) {
      return null;
    }
    const sizeResult = readVint(buf, pos + idLen);
    if (sizeResult === null) {
      return null;
    }

    const elemStart = pos;
    const valuePos = sizeResult.next;
    const valueSize = sizeResult.value;

    if (idLen === 2 && buf[elemStart] === 0x44 && buf[elemStart + 1] === 0x89) {
      const value = readDurationFloat(buf, valuePos, valueSize);
      if (value === null) {
        return null;
      }
      durationInScale = value;
    } else if (
      idLen === 3 &&
      buf[elemStart] === 0x2a &&
      buf[elemStart + 1] === 0xd7 &&
      buf[elemStart + 2] === 0xb1
    ) {
      const scale = readTimecodeScale(buf, valuePos, valueSize);
      if (scale !== null) {
        timecodeScaleNs = scale;
      }
    }

    pos = valuePos + Math.min(valueSize, buf.length - valuePos);
  }

  if (durationInScale === null) {
    return null;
  }
  return Math.ceil((durationInScale * timecodeScaleNs) / 1_000_000_000);
}

function findDurationInSegment(buf: Uint8Array, pos: number): number | null {
  while (pos + 2 <= buf.length) {
    const idLen = vintLen(buf[pos] ?? 0);
    if (idLen === null || pos + idLen > buf.length) {
      return null;
    }
    const sizeResult = readVint(buf, pos + idLen);
    if (sizeResult === null) {
      return null;
    }

    const elemStart = pos;
    const dataPos = sizeResult.next;
    const dataSize = sizeResult.value;

    if (
      idLen === 4 &&
      buf[elemStart] === 0x15 &&
      buf[elemStart + 1] === 0x49 &&
      buf[elemStart + 2] === 0xa9 &&
      buf[elemStart + 3] === 0x66
    ) {
      return findDurationInInfo(buf, dataPos, dataSize);
    }

    pos = dataPos + Math.min(dataSize, buf.length - dataPos);
  }
  return null;
}

function parseWebmDuration(buf: Uint8Array): number | null {
  if (buf.length < 12) {
    return null;
  }
  if (
    buf[0] !== EBML_HEADER[0] ||
    buf[1] !== EBML_HEADER[1] ||
    buf[2] !== EBML_HEADER[2] ||
    buf[3] !== EBML_HEADER[3]
  ) {
    return null;
  }

  let pos = 4;
  const ebmlSize = readVint(buf, pos);
  if (ebmlSize === null) {
    return null;
  }
  pos = ebmlSize.next + ebmlSize.value;

  if (pos + 4 > buf.length) {
    return null;
  }
  const segIdLen = vintLen(buf[pos] ?? 0);
  if (segIdLen === null || segIdLen !== 4) {
    return null;
  }
  pos += segIdLen;
  const segSizeLen = readVint(buf, pos);
  if (segSizeLen === null) {
    return null;
  }
  pos = segSizeLen.next;

  return findDurationInSegment(buf, pos);
}

export async function getAudioDuration(file: File): Promise<number | null> {
  const mimeType = file.type.split(";")[0] ?? file.type;
  const buf = new Uint8Array(
    await file
      .slice(0, Math.min(file.size, MAX_DURATION_READ_BYTES))
      .arrayBuffer(),
  );

  if (mimeType === "audio/webm") {
    return parseWebmDuration(buf);
  }
  if (
    mimeType === "audio/wav" ||
    mimeType === "audio/wave" ||
    mimeType === "audio/x-wav"
  ) {
    return sttWavDuration(buf);
  }
  return estimateDurationFromSize(file.size);
}

export const speechPricing$: Computed<Promise<SpeechPricing | null>> = computed(
  async (get): Promise<SpeechPricing | null> => {
    const db = get(db$);
    const [pricing] = await db
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
  },
);

export const checkSpeechCredits$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const { rows } = await writeDb.execute<CreditCheckRow>(sql`
      WITH member AS (
        SELECT credit_enabled FROM org_members_metadata
        WHERE org_id = ${args.orgId} AND user_id = ${args.userId}
        LIMIT 1
      ),
      org AS (
        SELECT credits FROM org_metadata
        WHERE org_id = ${args.orgId}
        LIMIT 1
      ),
      expired AS (
        SELECT COALESCE(SUM(remaining), 0)::bigint AS total
        FROM credit_expires_record
        WHERE org_id = ${args.orgId}
          AND expires_at <= now()
          AND remaining > 0
      )
      SELECT
        (SELECT credit_enabled FROM member) AS credit_enabled,
        (SELECT credits FROM org) AS credits,
        (SELECT total FROM expired) AS unsettled_expired
    `);
    signal.throwIfAborted();

    const row = rows[0];
    if (!row || row.credit_enabled === false || row.credits === null) {
      return false;
    }

    const credits = Number(row.credits);
    const unsettledExpired = Number(row.unsettled_expired ?? 0);
    return credits - unsettledExpired > 0;
  },
);

export const sttDailyPolicy$ = command(
  async (
    { get },
    orgId: string,
    userId: string,
    durationSeconds: number,
    signal: AbortSignal,
  ): Promise<SttDailyPolicy | ErrorResponse> => {
    const db = get(db$);
    const currentDate = nowDate();
    const rateKey = sttDailyRateKey(currentDate);
    const durationKey = sttDailyDurationKey(currentDate);
    const [orgRow] = await db
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();

    const orgTier = orgTierSchema.parse(orgRow?.tier ?? "free");
    const behaviorRows = await db
      .select({
        key: userBehaviorCount.behaviorKey,
        count: userBehaviorCount.count,
      })
      .from(userBehaviorCount)
      .where(
        and(
          eq(userBehaviorCount.orgId, orgId),
          eq(userBehaviorCount.userId, userId),
          inArray(userBehaviorCount.behaviorKey, [rateKey, durationKey]),
        ),
      );
    signal.throwIfAborted();

    const counts = new Map(
      behaviorRows.map((row): readonly [string, number] => {
        return [row.key, row.count];
      }),
    );
    const rateCount = counts.get(rateKey) ?? 0;
    const rateLimit = DAILY_RATE_LIMITS[orgTier];
    if (rateCount >= rateLimit) {
      return quotaError(
        429,
        "Daily request rate limit exceeded",
        "DAILY_RATE_LIMIT_EXCEEDED",
        rateCount,
        rateLimit,
      );
    }

    const dailyDurationSeconds = counts.get(durationKey) ?? 0;
    const durationLimit = DAILY_DURATION_LIMITS[orgTier];
    if (dailyDurationSeconds + durationSeconds > durationLimit) {
      return quotaError(
        429,
        "Daily audio duration limit exceeded",
        "DAILY_DURATION_LIMIT_EXCEEDED",
        dailyDurationSeconds,
        durationLimit,
      );
    }

    return { orgTier, rateKey, durationKey, durationSeconds };
  },
);

export const recordSttUsage$ = command(
  async (
    { set },
    params: SttDailyPolicy & {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await Promise.all([
      writeDb
        .insert(userBehaviorCount)
        .values({
          orgId: params.orgId,
          userId: params.userId,
          behaviorKey: params.rateKey,
          count: 1,
        })
        .onConflictDoUpdate({
          target: [
            userBehaviorCount.orgId,
            userBehaviorCount.userId,
            userBehaviorCount.behaviorKey,
          ],
          set: {
            count: sql`${userBehaviorCount.count} + 1`,
            lastAt: sql`now()`,
          },
        }),
      writeDb
        .insert(userBehaviorCount)
        .values({
          orgId: params.orgId,
          userId: params.userId,
          behaviorKey: params.durationKey,
          count: params.durationSeconds,
        })
        .onConflictDoUpdate({
          target: [
            userBehaviorCount.orgId,
            userBehaviorCount.userId,
            userBehaviorCount.behaviorKey,
          ],
          set: {
            count: sql`${userBehaviorCount.count} + ${params.durationSeconds}`,
            lastAt: sql`now()`,
          },
        }),
      params.orgTier === "free"
        ? writeDb
            .insert(userBehaviorCount)
            .values({
              orgId: params.orgId,
              userId: params.userId,
              behaviorKey: AUDIO_INPUT_BEHAVIOR_KEY,
              count: 1,
            })
            .onConflictDoUpdate({
              target: [
                userBehaviorCount.orgId,
                userBehaviorCount.userId,
                userBehaviorCount.behaviorKey,
              ],
              set: {
                count: sql`${userBehaviorCount.count} + 1`,
                lastAt: sql`now()`,
              },
            })
        : Promise.resolve(),
    ]);
    signal.throwIfAborted();
  },
);

export const recordGeneratedSpeech$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly voice: string;
      readonly audioBytes: Uint8Array;
      readonly durationSeconds: number;
      readonly pricing: SpeechPricing;
    },
    signal: AbortSignal,
  ): Promise<RecordedSpeech> => {
    const writeDb = set(writeDb$);
    const fileId = randomUUID();
    const filename = `voice-${fileId.slice(0, 8)}.wav`;
    const s3Key = buildArtifactKey(params.userId, fileId, filename);
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    await get(
      putS3Object(
        bucket,
        s3Key,
        Buffer.from(params.audioBytes),
        SPEECH_CONTENT_TYPE,
      ),
    );
    signal.throwIfAborted();

    const url = buildFileUrl(params.userId, fileId, filename);
    await set(
      recordWebUploadedFile$,
      {
        runId: params.runId,
        externalId: fileId,
        userId: params.userId,
        orgId: params.orgId,
        filename,
        contentType: SPEECH_CONTENT_TYPE,
        sizeBytes: params.audioBytes.byteLength,
        url,
        s3Key,
        metadata: {
          generatedBy: "zero-official-voice",
          model: VOICE_IO_TTS_MODEL,
          voice: params.voice,
          durationSeconds: params.durationSeconds,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    await writeDb.insert(usageEvent).values({
      runId: params.runId ?? null,
      idempotencyKey: randomUUID(),
      orgId: params.orgId,
      userId: params.userId,
      kind: USAGE_KIND,
      provider: USAGE_PROVIDER,
      category: USAGE_CATEGORY,
      quantity: params.durationSeconds,
    });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    return {
      id: fileId,
      filename,
      contentType: SPEECH_CONTENT_TYPE,
      size: params.audioBytes.byteLength,
      url,
      durationSeconds: params.durationSeconds,
      creditsCharged: estimatedSpeechCredits(
        params.durationSeconds,
        params.pricing,
      ),
      model: VOICE_IO_TTS_MODEL,
      voice: params.voice,
    };
  },
);
