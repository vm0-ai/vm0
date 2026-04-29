import { command } from "ccstate";
import { audioTranscriptionsV1Contract } from "@vm0/api-contracts/contracts/audio-transcriptions-v1";
import { orgTierSchema, type OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq, inArray, sql } from "drizzle-orm";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";

const PCM_SAMPLE_RATE = 16_000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;
const MAX_UPSTREAM_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PCM_BYTES = MAX_UPSTREAM_FILE_BYTES - WAV_HEADER_BYTES;
const OPENAI_TRANSCRIPTIONS_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const MAX_REQUEST_DURATION_SECONDS = 5 * 60;
const AUDIO_INPUT_FREE_QUOTA = 10;
const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";
const AUDIO_INPUT_FEATURE_KEY = "audioInput";
const DAILY_RATE_KEY_PREFIX = "audio_input_daily";
const DAILY_DURATION_KEY_PREFIX = "audio_input_dur";
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

const L = logger("AudioTranscriptionsV1");

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

type ErrorResponse =
  | ReturnType<typeof badRequest>
  | ReturnType<typeof payloadTooLarge>
  | ReturnType<typeof paymentRequired>
  | ReturnType<typeof forbidden>
  | ReturnType<typeof tooManyRequests>
  | ReturnType<typeof internalError>;

interface RawPcmRequest {
  readonly raw: Request;
  header(name: string): string | undefined;
}

interface PcmAudio {
  readonly pcm: Uint8Array;
}

interface VoiceInputPolicy {
  readonly orgTier: OrgTier;
  readonly rateKey: string;
  readonly durationKey: string;
  readonly durationSeconds: number;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string) {
  return { status: 400 as const, body: errorBody(message, "BAD_REQUEST") };
}

function payloadTooLarge(message: string) {
  return {
    status: 413 as const,
    body: errorBody(message, "PAYLOAD_TOO_LARGE"),
  };
}

function paymentRequired(message: string, code: string) {
  return { status: 402 as const, body: errorBody(message, code) };
}

function forbidden(message: string) {
  return { status: 403 as const, body: errorBody(message, "FORBIDDEN") };
}

function tooManyRequests(message: string, code: string) {
  return { status: 429 as const, body: errorBody(message, code) };
}

function internalError(message: string) {
  return {
    status: 500 as const,
    body: errorBody(message, "INTERNAL_SERVER_ERROR"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTranscriptionBody(
  value: unknown,
): value is { readonly text: string } {
  return isRecord(value) && typeof value.text === "string";
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    bytes[offset + i] = value.charCodeAt(i);
  }
}

function encodePcmS16leAsWav(pcm: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + pcm.byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const byteRate = (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;
  const blockAlign = (PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, PCM_CHANNELS, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PCM_BITS_PER_SAMPLE, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, WAV_HEADER_BYTES);

  return buffer;
}

function isRawPcmRequest(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/octet-stream";
}

function dailyRateKey(date?: Date): string {
  const d = date ?? nowDate();
  return `${DAILY_RATE_KEY_PREFIX}_${d.toISOString().slice(0, 10)}`;
}

function dailyDurationKey(date?: Date): string {
  const d = date ?? nowDate();
  return `${DAILY_DURATION_KEY_PREFIX}_${d.toISOString().slice(0, 10)}`;
}

function pcmDurationSeconds(pcmBytes: number): number {
  const bytesPerSecond =
    (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;
  return Math.ceil(pcmBytes / bytesPerSecond);
}

async function readRawPcm(
  request: RawPcmRequest,
): Promise<PcmAudio | ErrorResponse> {
  if (!isRawPcmRequest(request.header("content-type"))) {
    return badRequest(
      "Unsupported audio format. Send raw 16 kHz mono signed 16-bit PCM as application/octet-stream.",
    );
  }

  const contentLength = Number(request.header("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PCM_BYTES) {
    return payloadTooLarge("Audio file too large");
  }

  const pcm = new Uint8Array(await request.raw.arrayBuffer());
  if (pcm.byteLength === 0) {
    return badRequest("Audio body is required");
  }
  if (pcm.byteLength > MAX_PCM_BYTES) {
    return payloadTooLarge("Audio file too large");
  }
  if (pcm.byteLength % 2 !== 0) {
    return badRequest("PCM audio must contain whole 16-bit samples");
  }

  return { pcm };
}

const voiceInputPolicy$ = command(
  async (
    { get },
    orgId: string,
    userId: string,
    pcmBytes: number,
  ): Promise<VoiceInputPolicy | ErrorResponse> => {
    const db = get(db$);

    const [featureRow] = await db
      .select({ switches: userFeatureSwitches.switches })
      .from(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, orgId),
          eq(userFeatureSwitches.userId, userId),
        ),
      )
      .limit(1);
    if (featureRow?.switches[AUDIO_INPUT_FEATURE_KEY] === false) {
      return forbidden("Audio input is not enabled");
    }

    const currentDate = nowDate();
    const rateKey = dailyRateKey(currentDate);
    const durationKey = dailyDurationKey(currentDate);
    const [orgRow] = await db
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    const orgTier = orgTierSchema.parse(orgRow?.tier ?? "free");

    const behaviorKeys = [AUDIO_INPUT_BEHAVIOR_KEY, rateKey, durationKey];
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
          inArray(userBehaviorCount.behaviorKey, behaviorKeys),
        ),
      );
    const counts = new Map(
      behaviorRows.map((row): readonly [string, number] => {
        return [row.key, row.count];
      }),
    );
    const lifetimeAudioCount = counts.get(AUDIO_INPUT_BEHAVIOR_KEY) ?? 0;
    if (orgTier === "free" && lifetimeAudioCount >= AUDIO_INPUT_FREE_QUOTA) {
      return paymentRequired(
        "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
        "AUDIO_INPUT_QUOTA_EXCEEDED",
      );
    }

    const durationSeconds = pcmDurationSeconds(pcmBytes);
    if (durationSeconds > MAX_REQUEST_DURATION_SECONDS) {
      return badRequest(
        `Audio duration (${durationSeconds}s) exceeds maximum (${MAX_REQUEST_DURATION_SECONDS}s)`,
      );
    }

    const dailyRateCount = counts.get(rateKey) ?? 0;
    const dailyRateLimit = DAILY_RATE_LIMITS[orgTier];
    if (dailyRateCount >= dailyRateLimit) {
      return tooManyRequests(
        "Daily request rate limit exceeded",
        "DAILY_RATE_LIMIT_EXCEEDED",
      );
    }

    const dailyDurationSeconds = counts.get(durationKey) ?? 0;
    const dailyDurationLimit = DAILY_DURATION_LIMITS[orgTier];
    if (dailyDurationSeconds + durationSeconds > dailyDurationLimit) {
      return tooManyRequests(
        "Daily audio duration limit exceeded",
        "DAILY_DURATION_LIMIT_EXCEEDED",
      );
    }

    return { orgTier, rateKey, durationKey, durationSeconds };
  },
);

async function transcribePcm(
  pcm: Uint8Array,
  signal: AbortSignal,
): Promise<{ readonly text: string } | ErrorResponse> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([encodePcmS16leAsWav(pcm)], { type: "audio/wav" }),
    "audio.wav",
  );
  form.append("model", OPENAI_TRANSCRIPTION_MODEL);
  form.append("response_format", "json");

  const openaiResponse = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: form,
    signal,
  });

  if (!openaiResponse.ok) {
    L.error("OpenAI STT API error", {
      status: openaiResponse.status,
      statusText: openaiResponse.statusText,
      body: await openaiResponse.text(),
      pcmBytes: pcm.byteLength,
    });
    return internalError("Transcription failed");
  }

  const body: unknown = await openaiResponse.json();
  if (!isTranscriptionBody(body)) {
    return internalError("Transcription failed");
  }

  return { text: body.text };
}

const recordVoiceInputUsage$ = command(
  async (
    { set },
    params: VoiceInputPolicy & {
      readonly orgId: string;
      readonly userId: string;
    },
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
  },
);

const transcribeHandler$ = command(async ({ get, set }) => {
  const request = get(request$);
  const auth = get(authContext$);

  if (!auth.orgId) {
    return forbidden("This endpoint requires an organization-scoped API key");
  }

  const audio = await readRawPcm(request);
  if ("status" in audio) {
    return audio;
  }

  const policy = await set(
    voiceInputPolicy$,
    auth.orgId,
    auth.userId,
    audio.pcm.byteLength,
  );
  if ("status" in policy) {
    return policy;
  }

  const transcription = await transcribePcm(audio.pcm, request.raw.signal);
  if ("status" in transcription) {
    return transcription;
  }

  await set(recordVoiceInputUsage$, {
    ...policy,
    orgId: auth.orgId,
    userId: auth.userId,
  });

  return { status: 200 as const, body: { text: transcription.text } };
});

const transcribe$ = authRoute({ accept: ["pat"] }, transcribeHandler$);

export const audioTranscriptionsV1Routes: readonly RouteEntry[] = [
  { route: audioTranscriptionsV1Contract.transcribe, handler: transcribe$ },
];
