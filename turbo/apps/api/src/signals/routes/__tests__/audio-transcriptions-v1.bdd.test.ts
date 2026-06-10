import { randomUUID } from "node:crypto";

import { createApp } from "../../../app-factory";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
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

// BDD migration of the legacy `audio-transcriptions-v1.test.ts`.
// The 5 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// happy-path 200 chain (200 wraps raw PCM as WAV and
// transcribes it with OpenAI + the WAV header is verified
// end-to-end with the upstream mock capturing the WAV
// bytes), (2) auth + 400 + 402 + 403 chain (401 no API key →
// 400 empty PCM body → 402 audio input quota exceeded + OpenAI
// not called → 403 audio input feature switch disabled +
// OpenAI not called).
//
// Service-Level Exception: the route is invoked via the raw
// public app (not ts-rest) because the audio transcriptions
// contract accepts a raw PCM body. The OpenAI transcriptions
// endpoint is mocked via MSW. `orgMetadata`, `orgMembersCache`,
// `cliTokens`, `userBehaviorCount`, and `userFeatureSwitches`
// rows are seeded directly via `writeDb$` because no public
// route creates them.

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
  await writeDb.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
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
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
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

function createHarness(): {
  readonly authRequired: () => Promise<void>;
  readonly seedPat: () => Promise<PatFixture>;
} {
  const pats: PatFixture[] = [];

  afterEach(async () => {
    while (pats.length > 0) {
      const pat = pats.pop();
      if (pat) {
        await deletePatFixture(pat);
      }
    }
  });

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  const authRequired = async (): Promise<void> => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  };

  const seedPat = async (): Promise<PatFixture> => {
    const pat = await seedPatFixture();
    pats.push(pat);
    return pat;
  };

  return { authRequired, seedPat };
}

describe("BDD POST /api/v1/audio/transcriptions — happy path 200 chain", () => {
  it("gwt-wt-wt: 200 wraps raw PCM as WAV and transcribes it with OpenAI (upstream mock captures the WAV bytes + headers)", async () => {
    const { seedPat } = createHarness();

    // Given: a PAT fixture + an OpenAI transcriptions mock
    // that captures the request details.
    const pat = await seedPat();
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

    // When: post raw PCM audio.
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

    // Then: 200 + the response text matches + the upstream
    // WAV header is valid.
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
});

describe("BDD POST /api/v1/audio/transcriptions — auth + 400 + 402 + 403 chain", () => {
  it("gwt-wt-wt: 401 no API key → 400 empty PCM body → 402 audio input quota exceeded + OpenAI not called → 403 audio input feature switch disabled + OpenAI not called", async () => {
    const { seedPat } = createHarness();

    // Given: a session with no API key.
    server.resetHandlers();

    // When + Then: 401.
    const app = createApp({ signal: context.signal });
    const noKey = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Uint8Array.from([0x00, 0x00]),
    });
    expect(noKey.status).toBe(401);
    await expect(noKey.json()).resolves.toStrictEqual({
      error: { message: "API key required", code: "UNAUTHORIZED" },
    });

    // Given: a fresh PAT fixture.
    const emptyFx = await seedPat();

    // When + Then: 400 on empty PCM body.
    const empty = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${emptyFx.token}`,
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(),
    });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toStrictEqual({
      error: { message: "Audio body is required", code: "BAD_REQUEST" },
    });

    // Given: a fresh PAT fixture seeded at the free quota
    // limit.
    const quotaFx = await seedPat();
    const writeDb = store.set(writeDb$);
    await writeDb.insert(userBehaviorCount).values({
      orgId: quotaFx.orgId,
      userId: quotaFx.userId,
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

    // When + Then: 402 — audio input quota exceeded; OpenAI
    // is not called.
    const quota = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${quotaFx.token}`,
        "content-type": "application/octet-stream",
      },
      body: Uint8Array.from([0x00, 0x00]),
    });
    expect(quota.status).toBe(402);
    await expect(quota.json()).resolves.toStrictEqual({
      error: {
        message:
          "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
        code: "AUDIO_INPUT_QUOTA_EXCEEDED",
      },
    });
    expect(calledOpenAi).toBeFalsy();

    // Given: a fresh PAT fixture with the audio input feature
    // switch disabled.
    const featureFx = await seedPat();
    await writeDb.insert(userFeatureSwitches).values({
      orgId: featureFx.orgId,
      userId: featureFx.userId,
      switches: { [AUDIO_INPUT_FEATURE_KEY]: false },
    });
    calledOpenAi = false;

    // When + Then: 403 — audio input disabled; OpenAI is
    // not called.
    const disabled = await app.request("/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${featureFx.token}`,
        "content-type": "application/octet-stream",
      },
      body: Uint8Array.from([0x00, 0x00]),
    });
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toStrictEqual({
      error: { message: "Audio input is not enabled", code: "FORBIDDEN" },
    });
    expect(calledOpenAi).toBeFalsy();
  });
});
