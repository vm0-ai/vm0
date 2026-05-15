import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createApp } from "../../../app-factory";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { HttpResponse, http } from "msw";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  OPENAI_AUDIO_SPEECH_URL,
  OPENAI_AUDIO_TRANSCRIPTIONS_URL,
  SPEECH_CONTENT_TYPE,
  sttDailyDurationKey,
  sttDailyRateKey,
  TTS_CONTENT_TYPE,
  VOICE_IO_STT_MODEL,
  VOICE_IO_TTS_MODEL,
  type SpeechPricing,
} from "../../services/zero-voice-io-post.service";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const TEST_BUCKET = "test-user-storages";
const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";

interface VoiceFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly pricingInserted: boolean;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    bytes[offset + i] = value.charCodeAt(i);
  }
}

function wavBytes(durationSeconds: number): Uint8Array<ArrayBuffer> {
  const sampleRate = 24_000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize =
    sampleRate * channels * (bitsPerSample / 8) * durationSeconds;
  const buffer = new ArrayBuffer(44 + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);

  return bytes;
}

function wavBytesWithOversizedDataChunk(
  durationSeconds: number,
): Uint8Array<ArrayBuffer> {
  const sampleRate = 24_000;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = channels * (bitsPerSample / 8);
  const dataSize = sampleRate * bytesPerSample * durationSeconds;
  const junkSize = 4;
  const dataOffset = 56;
  const buffer = new ArrayBuffer(dataOffset + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const byteRate = sampleRate * bytesPerSample;

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(bytes, 36, "JUNK");
  view.setUint32(40, junkSize, true);
  writeAscii(bytes, 48, "data");
  view.setUint32(52, dataSize + 10_000, true);

  return bytes;
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["file:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function ensureSpeechPricing(): Promise<{
  readonly pricing: SpeechPricing;
  readonly inserted: boolean;
}> {
  const writeDb = store.set(writeDb$);
  const [existing] = await writeDb
    .select({
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "audio"),
        eq(usagePricing.provider, VOICE_IO_TTS_MODEL),
        eq(usagePricing.category, "output_audio_seconds"),
      ),
    )
    .limit(1);
  if (existing) {
    return { pricing: existing, inserted: false };
  }

  const pricing = { unitPrice: 5, unitSize: 1 };
  await writeDb.insert(usagePricing).values({
    kind: "audio",
    provider: VOICE_IO_TTS_MODEL,
    category: "output_audio_seconds",
    ...pricing,
  });
  return { pricing, inserted: true };
}

async function deleteSpeechPricing(): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "audio"),
        eq(usagePricing.provider, VOICE_IO_TTS_MODEL),
        eq(usagePricing.category, "output_audio_seconds"),
      ),
    );
}

async function seedVoiceFixture(options: {
  readonly audioOutputEnabled?: boolean;
  readonly credits?: number;
  readonly tier?: "free" | "pro" | "team";
  readonly withPricing?: boolean;
}): Promise<VoiceFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);

  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  await writeDb.insert(orgMetadata).values({
    orgId,
    tier: options.tier ?? "free",
    credits: options.credits ?? 10_000,
  });
  await writeDb.insert(orgMembersMetadata).values({
    orgId,
    userId,
    creditEnabled: true,
  });

  if (options.audioOutputEnabled) {
    await writeDb.insert(userFeatureSwitches).values({
      orgId,
      userId,
      switches: { [FeatureSwitchKey.AudioOutput]: true },
    });
  }

  const pricingResult = options.withPricing
    ? await ensureSpeechPricing()
    : { pricing: null, inserted: false };
  void pricingResult.pricing;

  return { orgId, userId, pricingInserted: pricingResult.inserted };
}

async function deleteVoiceFixture(fixture: VoiceFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.orgId, fixture.orgId),
        eq(runUploadedFiles.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(userBehaviorCount)
    .where(
      and(
        eq(userBehaviorCount.orgId, fixture.orgId),
        eq(userBehaviorCount.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
  if (fixture.pricingInserted) {
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "audio"),
          eq(usagePricing.provider, VOICE_IO_TTS_MODEL),
          eq(usagePricing.category, "output_audio_seconds"),
        ),
      );
  }
}

function expectedCredits(
  durationSeconds: number,
  pricing: SpeechPricing,
): number {
  return Math.ceil((durationSeconds * pricing.unitPrice) / pricing.unitSize);
}

describe("POST /api/zero/voice-io/*", () => {
  const track = createFixtureTracker<VoiceFixture>(deleteVoiceFixture);

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  it("proxies /tts to OpenAI when audio output is enabled", async () => {
    const fixture = await track(seedVoiceFixture({ audioOutputEnabled: true }));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const pcm = Uint8Array.from([1, 2, 3, 4]);
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return new HttpResponse(pcm, {
          status: 200,
          headers: { "content-type": TTS_CONTENT_TYPE },
        });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/tts", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "Read this aloud" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(TTS_CONTENT_TYPE);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(pcm);
    expect(observedAuthorization).toBe("Bearer test-openai-key");
    expect(observedBody).toMatchObject({
      model: VOICE_IO_TTS_MODEL,
      voice: "ash",
      input: "Read this aloud",
      response_format: "pcm",
    });
  });

  it("blocks /tts before OpenAI when audio output is disabled", async () => {
    const fixture = await track(seedVoiceFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, () => {
        calledOpenAi = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/tts", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "Read this aloud" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Audio output is not enabled", code: "FORBIDDEN" },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("returns /tts OpenAI failures as internal errors", async () => {
    const fixture = await track(seedVoiceFixture({ audioOutputEnabled: true }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, () => {
        return HttpResponse.json(
          { error: "rate_limit_exceeded" },
          { status: 429 },
        );
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/tts", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "Read this aloud" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "TTS generation failed",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
  });

  it("returns 401 from /stt when unauthenticated", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([wavBytes(1)], "speech.wav", { type: "audio/wav" }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/stt", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("transcribes /stt multipart audio and records quota counters", async () => {
    const fixture = await track(seedVoiceFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedFileName: string | undefined;
    let observedFileType: string | undefined;
    let observedModel: FormDataEntryValue | null = null;
    let observedResponseFormat: FormDataEntryValue | null = null;
    server.use(
      http.post(OPENAI_AUDIO_TRANSCRIPTIONS_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          return HttpResponse.json(
            { error: { message: "missing file", code: "BAD_REQUEST" } },
            { status: 400 },
          );
        }
        observedFileName = file.name;
        observedFileType = file.type;
        observedModel = form.get("model");
        observedResponseFormat = form.get("response_format");
        return HttpResponse.json({ text: "hello from voice" });
      }),
    );

    const form = new FormData();
    form.append(
      "file",
      new File([wavBytes(2)], "speech.wav", { type: "audio/wav" }),
    );
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "hello from voice",
    });
    expect(observedAuthorization).toBe("Bearer test-openai-key");
    expect(observedFileName).toBe("speech.wav");
    expect(observedFileType).toBe("audio/wav");
    expect(observedModel).toBe(VOICE_IO_STT_MODEL);
    expect(observedResponseFormat).toBe("json");

    const rows = await store
      .set(writeDb$)
      .select({
        key: userBehaviorCount.behaviorKey,
        count: userBehaviorCount.count,
      })
      .from(userBehaviorCount)
      .where(
        and(
          eq(userBehaviorCount.orgId, fixture.orgId),
          eq(userBehaviorCount.userId, fixture.userId),
        ),
      );
    const counts = new Map(
      rows.map((row): readonly [string, number] => {
        return [row.key, row.count];
      }),
    );
    expect(counts.get(AUDIO_INPUT_BEHAVIOR_KEY)).toBe(1);
    expect(counts.get(sttDailyRateKey())).toBe(1);
    expect(counts.get(sttDailyDurationKey())).toBe(2);
  });

  it("blocks /stt before OpenAI when the free audio quota is exhausted", async () => {
    const fixture = await track(seedVoiceFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await store.set(writeDb$).insert(userBehaviorCount).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      behaviorKey: AUDIO_INPUT_BEHAVIOR_KEY,
      count: 10,
    });

    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_AUDIO_TRANSCRIPTIONS_URL, () => {
        calledOpenAi = true;
        return HttpResponse.json({ text: "should not run" });
      }),
    );
    const form = new FormData();
    form.append(
      "file",
      new File([wavBytes(1)], "speech.wav", { type: "audio/wav" }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/stt", {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
        code: "AUDIO_INPUT_QUOTA_EXCEEDED",
      },
      quota: { count: 10, limit: 10 },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("returns 401 from /speech when unauthenticated", async () => {
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/speech", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("rejects empty /speech text before OpenAI", async () => {
    const fixture = await track(seedVoiceFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, () => {
        calledOpenAi = true;
        return new HttpResponse(wavBytes(1));
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/speech", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "   " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "text is required", code: "BAD_REQUEST" },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("rejects unsupported /speech voices before OpenAI", async () => {
    const fixture = await track(seedVoiceFixture({ withPricing: true }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, () => {
        calledOpenAi = true;
        return new HttpResponse(wavBytes(1));
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/speech", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "hello", voice: "unknown" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Unsupported voice: unknown", code: "BAD_REQUEST" },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("blocks /speech before OpenAI when credits are insufficient", async () => {
    const fixture = await track(
      seedVoiceFixture({ credits: 0, withPricing: true }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, () => {
        calledOpenAi = true;
        return new HttpResponse(wavBytes(1));
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/speech", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "hello" }),
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("blocks /speech before OpenAI when pricing is missing", async () => {
    const fixture = await track(seedVoiceFixture({ credits: 1000 }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, () => {
        calledOpenAi = true;
        return new HttpResponse(wavBytes(1));
      }),
    );

    await deleteSpeechPricing();
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/speech", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "hello" }),
    });
    await ensureSpeechPricing();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Audio generation pricing is not configured",
        code: "NOT_CONFIGURED",
      },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("generates /speech WAV files for run-scoped zero tokens", async () => {
    const fixture = await track(seedVoiceFixture({ withPricing: true }));
    const { pricing } = await ensureSpeechPricing();
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
      },
      context.signal,
    );

    const wav = wavBytes(2);
    let observedBody: unknown = null;
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, async ({ request }) => {
        observedBody = await request.json();
        return new HttpResponse(wav, {
          status: 200,
          headers: { "content-type": SPEECH_CONTENT_TYPE },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        text: "make this a file",
        voice: "marin",
        instructions: "calm delivery",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      contentType: SPEECH_CONTENT_TYPE,
      size: wav.byteLength,
      durationSeconds: 2,
      creditsCharged: expectedCredits(2, pricing),
      model: VOICE_IO_TTS_MODEL,
      voice: "marin",
    });
    expect(observedBody).toMatchObject({
      model: VOICE_IO_TTS_MODEL,
      voice: "marin",
      input: "make this a file",
      instructions: "calm delivery",
      response_format: "wav",
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body
      )
    ) {
      throw new Error("Expected speech response id and filename");
    }
    const fileId = String(body.id);
    const filename = String(body.filename);
    expect(filename).toBe(`voice-${fileId.slice(0, 8)}.wav`);

    const putInput = commandInput(context.mocks.s3.send.mock.calls[0]?.[0]);
    expect(putInput.Bucket).toBe(TEST_BUCKET);
    expect(putInput.Key).toBe(
      `uploads/${fixture.userId}/${fileId}/${filename}`,
    );
    expect(putInput.ContentType).toBe(SPEECH_CONTENT_TYPE);
    const putBody = putInput.Body;
    expect(Buffer.isBuffer(putBody)).toBeTruthy();
    if (!Buffer.isBuffer(putBody)) {
      throw new Error("Expected S3 put body to be a Buffer");
    }
    expect(new Uint8Array(putBody)).toStrictEqual(wav);

    const uploadRows = await store
      .set(writeDb$)
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.externalId, fileId));
    expect(uploadRows).toHaveLength(1);
    expect(uploadRows[0]).toMatchObject({
      runId,
      source: "web",
      externalId: fileId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      filename,
      contentType: SPEECH_CONTENT_TYPE,
      sizeBytes: wav.byteLength,
    });
    expect(uploadRows[0]?.metadata).toMatchObject({
      generatedBy: "zero-official-voice",
      model: VOICE_IO_TTS_MODEL,
      voice: "marin",
      durationSeconds: 2,
      s3Key: `uploads/${fixture.userId}/${fileId}/${filename}`,
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "audio"),
          eq(usageEvent.provider, VOICE_IO_TTS_MODEL),
          eq(usageEvent.category, "output_audio_seconds"),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      runId,
      quantity: 2,
      creditsCharged: expectedCredits(2, pricing),
      status: "processed",
      billingError: null,
    });
  });

  it("uses actual /speech WAV data bytes when the data chunk size is oversized", async () => {
    const fixture = await track(seedVoiceFixture({ withPricing: true }));
    const { pricing } = await ensureSpeechPricing();
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
      },
      context.signal,
    );
    const wav = wavBytesWithOversizedDataChunk(10);
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, () => {
        return new HttpResponse(wav, {
          status: 200,
          headers: { "content-type": SPEECH_CONTENT_TYPE },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "hello", voice: "nova" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      size: wav.byteLength,
      durationSeconds: 10,
      creditsCharged: expectedCredits(10, pricing),
      model: VOICE_IO_TTS_MODEL,
      voice: "nova",
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(eq(usageEvent.runId, runId));
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      runId,
      quantity: 10,
      creditsCharged: expectedCredits(10, pricing),
      status: "processed",
      billingError: null,
    });
  });

  it("returns 500 from /speech without persisted output when OpenAI fails", async () => {
    const fixture = await track(
      seedVoiceFixture({ credits: 1000, withPricing: true }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(OPENAI_AUDIO_SPEECH_URL, () => {
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/voice-io/speech", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "hello" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Speech generation failed",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    const uploadRows = await store
      .set(writeDb$)
      .select()
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.orgId, fixture.orgId),
          eq(runUploadedFiles.userId, fixture.userId),
        ),
      );
    expect(uploadRows).toHaveLength(0);

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "audio"),
          eq(usageEvent.provider, VOICE_IO_TTS_MODEL),
          eq(usageEvent.category, "output_audio_seconds"),
        ),
      );
    expect(usageRows).toHaveLength(0);

    const [metadata] = await store
      .set(writeDb$)
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    expect(metadata?.credits).toBe(1000);
  });
});
