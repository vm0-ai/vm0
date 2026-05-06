import { randomUUID } from "node:crypto";

import { createApp } from "../../../app-factory";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { HttpResponse, http } from "msw";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import { signPatJwtForTests } from "../../auth/tokens";

const OPENAI_TRANSCRIPTIONS_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const AUDIO_INPUT_BEHAVIOR_KEY = "audio_input";
const AUDIO_INPUT_FREE_QUOTA = 10;
const AUDIO_INPUT_FEATURE_KEY = "audioInput";

interface PatFixture {
  readonly token: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly orgId: string;
}

const store = createStore();
const context = testContext();

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function seedPatFixture(): Promise<PatFixture> {
  const tokenId = randomUUID();
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const nowSeconds = currentSecond();

  const token = signPatJwtForTests({
    scope: "cli",
    userId,
    orgId,
    tokenId,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
  const writeDb = store.set(writeDb$);

  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId,
    name: "test token",
    expiresAt: new Date(now() + 60_000),
  });
  await writeDb.insert(orgMembersCache).values({
    orgId,
    userId,
    role: "admin",
    cachedAt: new Date(now()),
  });

  return { token, tokenId, userId, orgId };
}

async function deletePatFixture(fixture: PatFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
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
    .delete(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, fixture.orgId),
        eq(orgMembersCache.userId, fixture.userId),
      ),
    );
  await writeDb.delete(cliTokens).where(eq(cliTokens.id, fixture.tokenId));
}

function decodeAscii(
  bytes: Uint8Array,
  offset: number,
  length: number,
): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function requireObservedWav(value: Uint8Array | null): Uint8Array {
  if (value === null) {
    throw new Error("Expected upstream WAV payload");
  }
  return value;
}

describe("POST /api/v1/audio/transcriptions", () => {
  const pats: PatFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (pats.length > 0) {
      const pat = pats.pop();
      if (pat) {
        await deletePatFixture(pat);
      }
    }
  });

  it("wraps raw PCM as WAV and transcribes it with OpenAI", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);

    let observedAuthorization: string | null = null;
    let observedFileName: string | undefined;
    let observedFileType: string | undefined;
    let observedModel: FormDataEntryValue | null = null;
    let observedResponseFormat: FormDataEntryValue | null = null;
    let observedWav: Uint8Array | null = null;
    server.use(
      http.post(OPENAI_TRANSCRIPTIONS_URL, async ({ request }) => {
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
        observedWav = new Uint8Array(await file.arrayBuffer());
        return HttpResponse.json({ text: "hello from buddy" });
      }),
    );

    const app = createApp({ signal: context.signal });
    const pcm = Uint8Array.from([0x00, 0x00, 0xff, 0x7f]);
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "content-type": "application/octet-stream",
      },
      body: pcm,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      text: "hello from buddy",
    });
    expect(observedAuthorization).toBe("Bearer test-openai-key");
    expect(observedFileName).toBe("audio.wav");
    expect(observedFileType).toBe("audio/wav");
    expect(observedModel).toBe(OPENAI_TRANSCRIPTION_MODEL);
    expect(observedResponseFormat).toBe("json");
    const wav = requireObservedWav(observedWav);
    expect(decodeAscii(wav, 0, 4)).toBe("RIFF");
    expect(decodeAscii(wav, 8, 4)).toBe("WAVE");
    expect(decodeAscii(wav, 36, 4)).toBe("data");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
    expect(new DataView(wav.buffer).getUint16(22, true)).toBe(1);
    expect(new DataView(wav.buffer).getUint16(34, true)).toBe(16);
    expect(wav.slice(44)).toStrictEqual(pcm);
  });

  it("returns 401 before transcribing when no API key is provided", async () => {
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Uint8Array.from([0x00, 0x00]),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "API key required", code: "UNAUTHORIZED" },
    });
  });

  it("rejects an empty PCM body before transcribing", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Audio body is required", code: "BAD_REQUEST" },
    });
  });

  it("enforces the free voice input quota before transcribing", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const writeDb = store.set(writeDb$);
    await writeDb.insert(userBehaviorCount).values({
      orgId: pat.orgId,
      userId: pat.userId,
      behaviorKey: AUDIO_INPUT_BEHAVIOR_KEY,
      count: AUDIO_INPUT_FREE_QUOTA,
    });

    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_TRANSCRIPTIONS_URL, () => {
        calledOpenAi = true;
        return HttpResponse.json({ text: "unexpected" });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "content-type": "application/octet-stream",
      },
      body: Uint8Array.from([0x00, 0x00]),
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
        code: "AUDIO_INPUT_QUOTA_EXCEEDED",
      },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("enforces the audio input feature switch before transcribing", async () => {
    const pat = await seedPatFixture();
    pats.push(pat);
    const writeDb = store.set(writeDb$);
    await writeDb.insert(userFeatureSwitches).values({
      orgId: pat.orgId,
      userId: pat.userId,
      switches: { [AUDIO_INPUT_FEATURE_KEY]: false },
    });

    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_TRANSCRIPTIONS_URL, () => {
        calledOpenAi = true;
        return HttpResponse.json({ text: "unexpected" });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "content-type": "application/octet-stream",
      },
      body: Uint8Array.from([0x00, 0x00]),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Audio input is not enabled", code: "FORBIDDEN" },
    });
    expect(calledOpenAi).toBeFalsy();
  });
});
