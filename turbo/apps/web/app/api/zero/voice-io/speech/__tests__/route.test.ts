import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import {
  createTestCompose,
  createTestRequest,
  createTestOrg,
  deleteTestUsagePricing,
  findTestUsageEventsByRunId,
  getOrgCredits,
  insertOrgMembersCacheEntry,
  insertTestChatThread,
  insertTestUsagePricing,
  setOrgCredits,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import { generateZeroToken } from "../../../../../../src/lib/auth/sandbox-token";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { findTestRunUploadedFiles } from "../../../../../../src/__tests__/db-test-assertions/run-uploaded-files";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";

vi.hoisted(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
});

const { POST } = await import("../route");

const context = testContext();
const SPEECH_URL = "http://localhost:3000/api/zero/voice-io/speech";
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

type SpeechResponse = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  durationSeconds: number;
  creditsCharged: number;
  model: string;
  voice: string;
};

async function setupOrg(userId: string) {
  const slug = uniqueId("speech");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function speechRequest(
  body: unknown,
  headers?: Record<string, string>,
): Request {
  return createTestRequest(SPEECH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function createWavBytes(durationSeconds: number): Uint8Array {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = (numChannels * bitsPerSample) / 8;
  const dataSize = durationSeconds * sampleRate * bytesPerSample;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);

  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  return bytes;
}

function createWavBytesWithJunkAndOversizedDataChunk(
  durationSeconds: number,
): Uint8Array {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = (numChannels * bitsPerSample) / 8;
  const dataSize = durationSeconds * sampleRate * bytesPerSample;
  const junkSize = 4;
  const dataOffset = 56;
  const bytes = new Uint8Array(dataOffset + dataSize);
  const view = new DataView(bytes.buffer);

  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "JUNK");
  view.setUint32(40, junkSize, true);
  writeStr(48, "data");
  view.setUint32(52, dataSize + 10_000, true);

  return bytes;
}

async function seedSpeechPricing() {
  await insertTestUsagePricing({
    kind: "audio",
    provider: "gpt-4o-mini-tts",
    category: "output_audio_seconds",
    unitPrice: 19,
    unitSize: 60,
  });
}

async function setupRunScopedToken(userId: string, orgId: string) {
  const { composeId } = await createTestCompose(uniqueId("speech-agent"));
  const threadId = await insertTestChatThread(userId, composeId, "Voices");
  const { runId } = await seedTestRun(userId, composeId, {
    chatThreadId: threadId,
    orgId,
    triggerSource: "schedule",
  });
  await insertOrgMembersCacheEntry({
    orgId,
    userId,
    role: "admin",
  });
  mockClerk({ userId: null });
  const token = await generateZeroToken(userId, runId, orgId);
  return { token, runId, threadId };
}

describe("POST /api/zero/voice-io/speech", () => {
  beforeEach(() => {
    context.setupMocks();
    mockAblyPublish.mockClear();
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(speechRequest({ text: "hello" }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when text is empty", async () => {
    const userId = uniqueId("speech-empty");
    await setupOrg(userId);

    const response = await POST(speechRequest({ text: "   " }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when voice is unsupported", async () => {
    const userId = uniqueId("speech-voice");
    await setupOrg(userId);

    const response = await POST(
      speechRequest({ text: "hello", voice: "unknown" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 402 when the org has no spendable credits", async () => {
    const userId = uniqueId("speech-empty-wallet");
    const { orgId } = await setupOrg(userId);
    await setOrgCredits(orgId, 0);

    const response = await POST(speechRequest({ text: "hello" }));
    const body = await response.json();

    expect(response.status).toBe(402);
    expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("returns 503 when speech pricing is not configured", async () => {
    const userId = uniqueId("speech-noprice");
    const { orgId } = await setupOrg(userId);
    await setOrgCredits(orgId, 1000);
    await deleteTestUsagePricing({
      kind: "audio",
      provider: "gpt-4o-mini-tts",
      category: "output_audio_seconds",
    });

    let openAiCalled = false;
    server.use(
      http.post(OPENAI_SPEECH_URL, () => {
        openAiCalled = true;
        return HttpResponse.text("unexpected");
      }),
    );

    const response = await POST(speechRequest({ text: "hello" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("NOT_CONFIGURED");
    expect(openAiCalled).toBe(false);
  });

  it("stores a /f WAV file, records it as a run artifact, and keeps usage runless", async () => {
    const userId = uniqueId("speech-ok");
    const { orgId } = await setupOrg(userId);
    const { token, runId, threadId } = await setupRunScopedToken(userId, orgId);
    await setOrgCredits(orgId, 1000);
    await seedSpeechPricing();
    const wavBytes = createWavBytes(10);

    server.use(
      http.post(OPENAI_SPEECH_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-openai-key",
        );
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          model: "gpt-4o-mini-tts",
          voice: "cedar",
          input: "hello world",
          instructions: "warm and concise",
          response_format: "wav",
        });

        return new HttpResponse(wavBytes, {
          headers: { "Content-Type": "audio/wav" },
        });
      }),
    );

    const response = await POST(
      speechRequest(
        {
          text: "hello world",
          voice: "cedar",
          instructions: "warm and concise",
        },
        { Authorization: `Bearer ${token}` },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as SpeechResponse;
    expect(body).toMatchObject({
      filename: expect.stringMatching(/^voice-[0-9a-f-]{8}\.wav$/),
      contentType: "audio/wav",
      size: wavBytes.byteLength,
      durationSeconds: 10,
      creditsCharged: 4,
      model: "gpt-4o-mini-tts",
      voice: "cedar",
    });
    expect(body.id).toEqual(expect.any(String));
    expect(body.url).toBe(
      `http://localhost:3000/f/${encodeURIComponent(userId.replace(/^user_/, ""))}/${body.id}/${body.filename}`,
    );

    expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledTimes(1);
    const [bucket, key, uploadedBytes, contentType] =
      context.mocks.s3.uploadS3Buffer.mock.calls[0]!;
    expect(bucket).toBe("test-bucket");
    expect(key).toBe(`uploads/${userId}/${body.id}/${body.filename}`);
    expect(uploadedBytes.equals(Buffer.from(wavBytes))).toBe(true);
    expect(contentType).toBe("audio/wav");

    const rows = await findTestRunUploadedFiles("schedule", body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      source: "schedule",
      externalId: body.id,
      userId,
      orgId,
      filename: body.filename,
      contentType: "audio/wav",
      sizeBytes: wavBytes.byteLength,
      url: body.url,
      metadata: expect.objectContaining({
        generatedBy: "zero-official-voice",
        model: "gpt-4o-mini-tts",
        voice: "cedar",
        s3Key: `uploads/${userId}/${body.id}/${body.filename}`,
      }),
    });
    expect(mockAblyPublish).toHaveBeenCalledWith(
      `chatThreadArtifactsChanged:${threadId}`,
      null,
    );
    expect(await getOrgCredits(orgId)).toBe(996);
    expect(await findTestUsageEventsByRunId(runId)).toEqual([]);
  });

  it("estimates WAV duration from actual data bytes when data chunk size is oversized", async () => {
    const userId = uniqueId("speech-oversized-data");
    const { orgId } = await setupOrg(userId);
    const { token, runId } = await setupRunScopedToken(userId, orgId);
    await setOrgCredits(orgId, 1000);
    await seedSpeechPricing();
    const wavBytes = createWavBytesWithJunkAndOversizedDataChunk(10);

    server.use(
      http.post(OPENAI_SPEECH_URL, () => {
        return new HttpResponse(wavBytes, {
          headers: { "Content-Type": "audio/wav" },
        });
      }),
    );

    const response = await POST(
      speechRequest(
        { text: "hello world", voice: "nova" },
        { Authorization: `Bearer ${token}` },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as SpeechResponse;
    expect(body.durationSeconds).toBe(10);
    expect(body.creditsCharged).toBe(4);
    expect(await getOrgCredits(orgId)).toBe(996);
    expect(await findTestUsageEventsByRunId(runId)).toEqual([]);
  });

  it("returns 500 when OpenAI speech generation fails", async () => {
    const userId = uniqueId("speech-openai-fail");
    const { orgId } = await setupOrg(userId);
    await setOrgCredits(orgId, 1000);
    await seedSpeechPricing();

    server.use(
      http.post(OPENAI_SPEECH_URL, () => {
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const response = await POST(speechRequest({ text: "hello" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(context.mocks.s3.uploadS3Buffer).not.toHaveBeenCalled();
    expect(await getOrgCredits(orgId)).toBe(1000);
  });
});
