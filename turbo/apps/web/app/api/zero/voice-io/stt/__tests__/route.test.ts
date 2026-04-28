import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestOrg,
  updateOrgTier,
} from "../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import {
  readBehaviorCount,
  seedBehaviorCount,
} from "../../../../../../src/__tests__/db-test-seeders/behavior";
import {
  AUDIO_INPUT_BEHAVIOR_KEY,
  AUDIO_INPUT_FREE_QUOTA,
  DAILY_RATE_LIMITS,
  DAILY_DURATION_LIMITS,
  dailyRateKey,
  dailyDurationKey,
} from "../../../../../../src/lib/zero/voice-io/audio-input-policy";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

vi.hoisted(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
});

const { POST } = await import("../route");

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("stt");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function createAudioFile(
  size = 1024,
  type = "audio/webm",
  name = "recording.webm",
): File {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

function createWavFile(durationSeconds: number): File {
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = (numChannels * bitsPerSample) / 8;
  const dataSize = durationSeconds * sampleRate * bytesPerSample;

  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
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

  return new File([buf], "test.wav", { type: "audio/wav" });
}

function createSttRequest(file?: File): Request {
  const formData = new FormData();
  if (file) formData.append("file", file);
  return new Request("http://localhost:3000/api/zero/voice-io/stt", {
    method: "POST",
    body: formData,
  });
}

describe("POST /api/zero/voice-io/stt", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 when feature flag is disabled", async () => {
    const userId = uniqueId("stt-ff");
    await setupOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 when no file is provided", async () => {
    const userId = uniqueId("stt-nofile");
    await setupOrg(userId);
    const response = await POST(createSttRequest());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for unsupported file type", async () => {
    const userId = uniqueId("stt-badtype");
    await setupOrg(userId);
    const file = createAudioFile(1024, "text/plain", "notes.txt");
    const response = await POST(createSttRequest(file));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for file exceeding 25MB", async () => {
    const userId = uniqueId("stt-big");
    await setupOrg(userId);
    const file = createAudioFile(26 * 1024 * 1024);
    const response = await POST(createSttRequest(file));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should accept MIME types with codec suffix", async () => {
    const userId = uniqueId("stt-codec");
    await setupOrg(userId);

    server.use(
      http.post("https://api.openai.com/v1/audio/transcriptions", () => {
        return HttpResponse.json({ text: "Hello from codec test" });
      }),
    );

    const file = createAudioFile(
      1024,
      "audio/webm;codecs=opus",
      "recording.webm",
    );
    const response = await POST(createSttRequest(file));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.text).toBe("Hello from codec test");
  });

  it("should return transcribed text on success", async () => {
    const userId = uniqueId("stt-ok");
    await setupOrg(userId);

    server.use(
      http.post("https://api.openai.com/v1/audio/transcriptions", () => {
        return HttpResponse.json({ text: "Hello, world!" });
      }),
    );

    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.text).toBe("Hello, world!");
  });

  it("should return 500 when OpenAI API fails", async () => {
    const userId = uniqueId("stt-fail");
    await setupOrg(userId);

    server.use(
      http.post("https://api.openai.com/v1/audio/transcriptions", () => {
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  describe("org tier quota gating", () => {
    it("should not increment the counter for a pro org across multiple successes", async () => {
      const userId = uniqueId("stt-pro");
      const { orgId } = await setupOrg(userId);
      await updateOrgTier(orgId, "pro");

      server.use(
        http.post("https://api.openai.com/v1/audio/transcriptions", () => {
          return HttpResponse.json({ text: "pro transcript" });
        }),
      );

      for (let i = 0; i < 5; i++) {
        const response = await POST(createSttRequest(createAudioFile()));
        expect(response.status).toBe(200);
      }

      const count = await readBehaviorCount(
        orgId,
        userId,
        AUDIO_INPUT_BEHAVIOR_KEY,
      );
      expect(count).toBe(0);
    });

    it("should increment the counter on each successful free-tier call up to the quota", async () => {
      const userId = uniqueId("stt-free");
      const { orgId } = await setupOrg(userId);

      server.use(
        http.post("https://api.openai.com/v1/audio/transcriptions", () => {
          return HttpResponse.json({ text: "free transcript" });
        }),
      );

      for (let i = 1; i <= AUDIO_INPUT_FREE_QUOTA; i++) {
        const response = await POST(createSttRequest(createAudioFile()));
        expect(response.status).toBe(200);
        const count = await readBehaviorCount(
          orgId,
          userId,
          AUDIO_INPUT_BEHAVIOR_KEY,
        );
        expect(count).toBe(i);
      }
    });

    it("should return 402 once the free-tier quota is exhausted and leave the counter unchanged", async () => {
      const userId = uniqueId("stt-free-exceed");
      const { orgId } = await setupOrg(userId);

      server.use(
        http.post("https://api.openai.com/v1/audio/transcriptions", () => {
          return HttpResponse.json({ text: "ok" });
        }),
      );

      // Exhaust the quota with AUDIO_INPUT_FREE_QUOTA successful calls
      for (let i = 0; i < AUDIO_INPUT_FREE_QUOTA; i++) {
        const ok = await POST(createSttRequest(createAudioFile()));
        expect(ok.status).toBe(200);
      }

      const response = await POST(createSttRequest(createAudioFile()));
      const body = await response.json();
      expect(response.status).toBe(402);
      expect(body.error.code).toBe("AUDIO_INPUT_QUOTA_EXCEEDED");
      expect(body.quota).toEqual({
        count: AUDIO_INPUT_FREE_QUOTA,
        limit: AUDIO_INPUT_FREE_QUOTA,
      });

      const count = await readBehaviorCount(
        orgId,
        userId,
        AUDIO_INPUT_BEHAVIOR_KEY,
      );
      expect(count).toBe(AUDIO_INPUT_FREE_QUOTA);
    });

    it("should not increment the counter when OpenAI fails on the first free-tier call", async () => {
      const userId = uniqueId("stt-free-infra-fail");
      const { orgId } = await setupOrg(userId);

      server.use(
        http.post("https://api.openai.com/v1/audio/transcriptions", () => {
          return HttpResponse.json(
            { error: { message: "boom" } },
            { status: 500 },
          );
        }),
      );

      const response = await POST(createSttRequest(createAudioFile()));
      expect(response.status).toBe(500);

      const count = await readBehaviorCount(
        orgId,
        userId,
        AUDIO_INPUT_BEHAVIOR_KEY,
      );
      expect(count).toBe(0);
    });
  });

  describe("daily rate limit", () => {
    it("should return 429 when daily rate limit exceeded", async () => {
      const userId = uniqueId("stt-daily-rate");
      const { orgId } = await setupOrg(userId);
      await updateOrgTier(orgId, "pro");
      const limit = DAILY_RATE_LIMITS["pro"]!;

      await seedBehaviorCount(orgId, userId, dailyRateKey(), limit);

      server.use(
        http.post("https://api.openai.com/v1/audio/transcriptions", () => {
          return HttpResponse.json({ text: "should not reach" });
        }),
      );

      const response = await POST(createSttRequest(createAudioFile()));
      expect(response.status).toBe(429);
      expect((await response.json()).error.code).toBe(
        "DAILY_RATE_LIMIT_EXCEEDED",
      );
    });

    it("should return 429 when daily duration limit exceeded", async () => {
      const userId = uniqueId("stt-daily-dur");
      const { orgId } = await setupOrg(userId);
      await updateOrgTier(orgId, "pro");

      const limit = DAILY_DURATION_LIMITS["pro"]!;
      await seedBehaviorCount(orgId, userId, dailyDurationKey(), limit + 1);

      server.use(
        http.post("https://api.openai.com/v1/audio/transcriptions", () => {
          return HttpResponse.json({ text: "should not reach" });
        }),
      );

      const response = await POST(createSttRequest(createAudioFile()));
      expect(response.status).toBe(429);
      expect((await response.json()).error.code).toBe(
        "DAILY_DURATION_LIMIT_EXCEEDED",
      );
    });
  });

  describe("daily rate and duration recording", () => {
    it("should increment daily rate and duration counters on success", async () => {
      const userId = uniqueId("stt-daily-ok");
      const { orgId } = await setupOrg(userId);
      await updateOrgTier(orgId, "pro");

      server.use(
        http.post("https://api.openai.com/v1/audio/transcriptions", () => {
          return HttpResponse.json({ text: "daily tracking test" });
        }),
      );

      // Use a real WAV file so getAudioDuration returns an actual duration
      const wavFile = createWavFile(30);
      const formData = new FormData();
      formData.append("file", wavFile);
      const req = new Request("http://localhost:3000/api/zero/voice-io/stt", {
        method: "POST",
        body: formData,
      });
      const response = await POST(req);
      expect(response.status).toBe(200);

      const rateCount = await readBehaviorCount(orgId, userId, dailyRateKey());
      expect(rateCount).toBe(1);

      const durCount = await readBehaviorCount(
        orgId,
        userId,
        dailyDurationKey(),
      );
      expect(durCount).toBe(30);
    });

    it("should not increment daily counters on OpenAI failure", async () => {
      const userId = uniqueId("stt-daily-fail");
      const { orgId } = await setupOrg(userId);
      await updateOrgTier(orgId, "pro");

      server.use(
        http.post("https://api.openai.com/v1/audio/transcriptions", () => {
          return HttpResponse.json(
            { error: { message: "boom" } },
            { status: 500 },
          );
        }),
      );

      const response = await POST(createSttRequest(createAudioFile()));
      expect(response.status).toBe(500);

      const rateCount = await readBehaviorCount(orgId, userId, dailyRateKey());
      expect(rateCount).toBe(0);

      const durCount = await readBehaviorCount(
        orgId,
        userId,
        dailyDurationKey(),
      );
      expect(durCount).toBe(0);
    });
  });
});
