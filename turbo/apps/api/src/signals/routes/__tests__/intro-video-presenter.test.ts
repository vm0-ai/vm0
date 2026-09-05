import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { introVideoPresenterContract } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { buildArtifactKey, buildFileUrlFromKey } from "../../../lib/file-url";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { introVideoPresenterRoutes } from "../intro-video-presenter";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { seedCompose$, seedRun$ } from "./helpers/usage-state";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

const HEYGEN_CREATE_URL = "https://api.heygen.com/v3/videos";
const HEYGEN_AVATARS_URL = "https://api.heygen.com/v3/avatars/looks";
const HEYGEN_STYLES_URL = "https://api.heygen.com/v3/video-agents/styles";
const HEYGEN_VOICES_URL = "https://api.heygen.com/v3/voices";
const HEYGEN_SPEECH_URL = `${HEYGEN_VOICES_URL}/speech`;
const HEYGEN_VIDEO_ID = "heygen-video-123";
const HEYGEN_STATUS_URL = `${HEYGEN_CREATE_URL}/${HEYGEN_VIDEO_ID}`;
const HEYGEN_VIDEO_URL = "https://files.heygen.test/presenter.webm";
const HEYGEN_AUDIO_URL = "https://files.heygen.test/narration.mp3";
const VIDEO_BYTES = Buffer.from("generated intro video presenter");
const AUDIO_BYTES = Buffer.from("generated intro video narration");
const PRICING_ROWS = [
  {
    kind: "video",
    provider: "heygen-avatar-iii",
    category: "output_video_seconds",
    unitPrice: 1250,
    unitSize: 60,
  },
  {
    kind: "audio",
    provider: "heygen-starfish-tts",
    category: "output_audio_seconds",
    unitPrice: 40,
    unitSize: 60,
  },
] as const satisfies readonly UsagePricingRow[];

interface IntroVideoPresenterFixture {
  readonly orgId: string;
  readonly usagePricingResolution: UsagePricingFixture["resolution"];
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createIntroVideoPresenterTestApp(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...introVideoPresenterRoutes,
      ...artifactCatalogRoutes,
      ...builtInGenerationRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
    ],
    usagePricingResolution,
  });
}

function introVideoPresenterClient(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return setupApp({
    context,
    routes: introVideoPresenterRoutes,
    usagePricingResolution,
  })(introVideoPresenterContract);
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly publicBrand?: "vm0" | "okou";
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["file:write"],
    ...(args.publicBrand ? { publicBrand: args.publicBrand } : {}),
    iat: seconds,
    exp: seconds + 60,
  });
}

async function seedFixture(): Promise<IntroVideoPresenterFixture> {
  const pricing = await createUsagePricingFixture({ configured: PRICING_ROWS });
  onTestFinished(pricing.cleanup);
  const fixture = {
    orgId: `org_${randomUUID()}`,
    usagePricingResolution: pricing.resolution,
    userId: `user_${randomUUID()}`,
  };
  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: "team",
    credits: 10_000,
  });
  await store.set(
    seedOrgMembership$,
    { ...fixture, role: "admin" },
    context.signal,
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function enableIntroVideo(
  fixture: IntroVideoPresenterFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.IntroVideo]: true,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Expected record");
}

function readGenerationId(value: unknown, userId: string): string {
  const body = asRecord(value);
  if (typeof body.generationId !== "string") {
    throw new Error("Expected generation ID");
  }
  expect(body).toMatchObject({
    generationId: body.generationId,
    type: "video",
    status: "queued",
    realtime: {
      channelName: `user:${userId}`,
      eventName: `built-in-generation:${body.generationId}`,
    },
  });
  return body.generationId;
}

async function orgCredits(
  fixture: IntroVideoPresenterFixture,
): Promise<number> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const response = await createIntroVideoPresenterTestApp(
    fixture.usagePricingResolution,
  ).request("/api/billing/status", { headers: authHeaders() });
  expect(response.status).toBe(200);
  const body = asRecord(await response.json());
  if (typeof body.credits !== "number") {
    throw new Error("Expected numeric credit balance");
  }
  return body.credits;
}

describe("Intro Video HeyGen presenter route", () => {
  beforeEach(() => {
    mockEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://artifacts.vm0.test");
    mockEnv("HEYGEN_API_KEY", "test-heygen-key");
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.ably.createTokenRequest.mockResolvedValue({
      keyName: "test-key",
      timestamp: 1_700_000_000_000,
      capability: '{"user:test-user":["subscribe"]}',
      clientId: "test-user",
      nonce: "test-nonce",
      mac: "test-mac",
    });
  });

  it("rejects agent requests while Intro Video is disabled", async () => {
    const fixture = await seedFixture();
    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
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
    const response = await createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    ).request("/api/intro-video/presenter/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${okouToken({ ...fixture, runId })}` },
      body: JSON.stringify({
        avatarId: "Abigail_standing_office_front",
        audioUrl: "https://example.com/narration.mp3",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Intro Video is not enabled",
      },
    });
  });

  it("honors the Intro Video email rollout for catalog requests", async () => {
    const fixture = await seedFixture();
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: fixture.userId,
          primaryEmailAddressId: "email_bingjie",
          emailAddresses: [
            {
              id: "email_bingjie",
              emailAddress: "bingjie@vm0.ai",
            },
          ],
        },
      ],
    });
    server.use(
      http.get(HEYGEN_VOICES_URL, () => {
        return HttpResponse.json({
          data: [],
          has_more: false,
          next_token: null,
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    ).request("/api/intro-video/voices?pageSize=24", {
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      voices: [],
      hasMore: false,
      nextToken: null,
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      userId: [fixture.userId],
      limit: 1,
    });
  });

  it("rejects direct sessions and non-curated presenter IDs", async () => {
    const fixture = await seedFixture();
    const app = createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const sessionResponse = await app.request(
      "/api/intro-video/presenter/generate",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          avatarId: "Abigail_standing_office_front",
          audioUrl: "https://example.com/narration.mp3",
        }),
      },
    );
    expect(sessionResponse.status).toBe(403);

    await enableIntroVideo(fixture);

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
    const token = okouToken({ ...fixture, runId });
    const unknownAvatarResponse = await app.request(
      "/api/intro-video/presenter/generate",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          avatarId: "private_or_removed_look",
          audioUrl: "https://example.com/narration.mp3",
        }),
      },
    );
    expect(unknownAvatarResponse.status).toBe(400);
    await expect(unknownAvatarResponse.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("lists only public HeyGen Starfish voices for the wizard", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
    let voiceRequests = 0;
    server.use(
      http.get(HEYGEN_VOICES_URL, ({ request }) => {
        voiceRequests += 1;
        const url = new URL(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
          type: "public",
          engine: "starfish",
          limit: "24",
          language: "English",
          gender: "female",
        });
        return HttpResponse.json({
          data: [
            {
              voice_id: "330290724a1b470fb63153f34d4c0183",
              name: "Annie - Lifelike",
              language: "English",
              gender: "female",
              preview_audio_url: "https://files.heygen.test/annie.wav",
              type: "public",
            },
          ],
          has_more: true,
          next_token: "next-voice-page",
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    ).request(
      "/api/intro-video/voices?pageSize=24&language=English&gender=female",
      { headers: authHeaders() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      voices: [
        {
          id: "330290724a1b470fb63153f34d4c0183",
          name: "Annie - Lifelike",
          language: "English",
          gender: "female",
          sampleUrl: "https://files.heygen.test/annie.wav",
        },
      ],
      hasMore: true,
      nextToken: "next-voice-page",
    });
    expect(voiceRequests).toBe(1);

    server.use(
      http.get(HEYGEN_VOICES_URL, () => {
        return HttpResponse.json(
          { error: { message: "invalid page token" } },
          { status: 400 },
        );
      }),
    );
    const invalidTokenResponse = await accept(
      introVideoPresenterClient(fixture.usagePricingResolution).voices({
        headers: authHeaders(),
        query: { token: "expired" },
      }),
      [400],
    );
    expect(invalidTokenResponse.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "HeyGen rejected the request: invalid page token",
      },
    });
  });

  it("lists public HeyGen styles and Avatar III looks for the simple form", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
    server.use(
      http.get(HEYGEN_STYLES_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
          limit: "24",
        });
        return HttpResponse.json({
          data: [
            {
              style_id: "349d91e1ad2444eabab2672a9057f298",
              name: "Thriller",
              thumbnail_url: "https://files.heygen.test/thriller.jpg",
              preview_video_url: "https://files.heygen.test/thriller.mp4",
              tags: ["cinematic"],
              aspect_ratio: "16:9",
            },
          ],
          has_more: false,
          next_token: null,
        });
      }),
      http.get(HEYGEN_AVATARS_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
          ownership: "public",
          avatar_type: "studio_avatar",
          limit: "24",
        });
        return HttpResponse.json({
          data: [
            {
              id: "Daphne_public_1",
              group_id: "c1926d821b4d43d6a5f07f2985bb5cd1",
              name: "Daphne in Grey blazer",
              default_voice_id: "812d4eea4a8442a382dcaf2dbaddbd93",
              preview_image_url: "https://files.heygen.test/daphne.webp",
              preview_video_url: "https://files.heygen.test/daphne.mp4",
              gender: "female",
              image_width: 1080,
              image_height: 1080,
              preferred_orientation: "portrait",
              status: "completed",
              supported_api_engines: ["avatar_iii"],
            },
            {
              id: "Legacy_public_1",
              group_id: "legacy-group",
              name: "Legacy",
              default_voice_id: "legacy-voice",
              status: "completed",
              supported_api_engines: ["avatar_iv"],
            },
          ],
          has_more: false,
          next_token: null,
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    );

    const [stylesResponse, avatarsResponse] = await Promise.all([
      app.request("/api/intro-video/styles?pageSize=24", {
        headers: authHeaders(),
      }),
      app.request("/api/intro-video/avatars?pageSize=24", {
        headers: authHeaders(),
      }),
    ]);

    expect(stylesResponse.status).toBe(200);
    await expect(stylesResponse.json()).resolves.toStrictEqual({
      styles: [
        {
          id: "349d91e1ad2444eabab2672a9057f298",
          name: "Thriller",
          thumbnailUrl: "https://files.heygen.test/thriller.jpg",
          previewVideoUrl: "https://files.heygen.test/thriller.mp4",
          tags: ["cinematic"],
          aspectRatio: "16:9",
        },
      ],
      hasMore: false,
      nextToken: null,
    });
    expect(avatarsResponse.status).toBe(200);
    await expect(avatarsResponse.json()).resolves.toStrictEqual({
      avatars: [
        {
          id: "Daphne_public_1",
          groupId: "c1926d821b4d43d6a5f07f2985bb5cd1",
          name: "Daphne in Grey blazer",
          defaultVoiceId: "812d4eea4a8442a382dcaf2dbaddbd93",
          previewImageUrl: "https://files.heygen.test/daphne.webp",
          previewVideoUrl: "https://files.heygen.test/daphne.mp4",
          gender: "female",
          imageWidth: 1080,
          imageHeight: 1080,
          preferredOrientation: "portrait",
        },
      ],
      hasMore: false,
      nextToken: null,
    });
  });

  it("rejects a dynamically selected avatar that is not public", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
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
    server.use(
      http.get(HEYGEN_AVATARS_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
          ownership: "public",
          avatar_type: "studio_avatar",
          limit: "100",
          group_id: "private-group",
        });
        return HttpResponse.json({
          data: [],
          has_more: false,
          next_token: null,
        });
      }),
    );
    const response = await createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    ).request("/api/intro-video/presenter/generate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${okouToken({ ...fixture, runId })}`,
      },
      body: JSON.stringify({
        avatarId: "Private_avatar_1",
        avatarGroupId: "private-group",
        audioUrl: "https://example.com/narration.mp3",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "HeyGen avatar is not available in Intro Video",
      },
    });
  });

  it("generates the selected HeyGen voice once for presenter and mix", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
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
    const voiceId = "330290724a1b470fb63153f34d4c0183";
    let speechRequests = 0;
    let audioDownloads = 0;
    server.use(
      http.get(HEYGEN_VOICES_URL, ({ request }) => {
        expect(
          Object.fromEntries(new URL(request.url).searchParams),
        ).toStrictEqual({
          type: "public",
          engine: "starfish",
          limit: "100",
        });
        return HttpResponse.json({
          data: [
            {
              voice_id: voiceId,
              name: "Annie - Lifelike",
              type: "public",
            },
          ],
          has_more: false,
          next_token: null,
        });
      }),
      http.post(HEYGEN_SPEECH_URL, async ({ request }) => {
        speechRequests += 1;
        expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
        await expect(request.json()).resolves.toStrictEqual({
          text: "Welcome to the launch.",
          voice_id: voiceId,
          input_type: "text",
          speed: 1,
        });
        return HttpResponse.json({
          data: {
            audio_url: HEYGEN_AUDIO_URL,
            duration: 61,
            request_id: "speech-request-123",
          },
        });
      }),
      http.get(HEYGEN_AUDIO_URL, () => {
        audioDownloads += 1;
        return new HttpResponse(AUDIO_BYTES, {
          headers: { "content-type": "audio/mpeg" },
        });
      }),
    );
    const response = await createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    ).request("/api/intro-video/voice/generate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${okouToken({
          ...fixture,
          runId,
          publicBrand: "okou",
        })}`,
      },
      body: JSON.stringify({
        voiceId,
        text: "Welcome to the launch.",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: expect.any(String),
      filename: expect.stringMatching(/^intro-video-voice-.*\.mp3$/u),
      contentType: "audio/mpeg",
      size: AUDIO_BYTES.byteLength,
      url: expect.any(String),
      durationSeconds: 61,
      creditsCharged: 41,
      voiceId,
    });
    expect(speechRequests).toBe(1);
    expect(audioDownloads).toBe(1);
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return (
          command instanceof PutObjectCommand &&
          command.input.ContentType === "audio/mpeg" &&
          command.input.Metadata?.["public-brand"] === "okou"
        );
      }),
    ).toBeTruthy();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    for (const query of ["", "?kind=file"]) {
      const catalogResponse = await createIntroVideoPresenterTestApp(
        fixture.usagePricingResolution,
      ).request(`/api/artifacts/catalog${query}`, {
        headers: authHeaders(),
      });
      expect(catalogResponse.status).toBe(200);
      expect(asRecord(await catalogResponse.json()).artifacts).toStrictEqual(
        [],
      );
    }
    await expect(orgCredits(fixture)).resolves.toBe(9959);
  });

  it("renders a curated presenter through HeyGen v3 idempotently", async () => {
    const fixture = await seedFixture();
    await enableIntroVideo(fixture);
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
    const audioKey = buildArtifactKey(
      fixture.userId,
      randomUUID(),
      "narration.mp3",
    );
    const audioUrl = buildFileUrlFromKey(audioKey, "okou");
    const token = okouToken({ ...fixture, runId, publicBrand: "okou" });
    const observedCreateRequests: {
      readonly body: Record<string, unknown>;
      readonly idempotencyKey: string | null;
    }[] = [];
    let statusCalls = 0;
    let videoDownloads = 0;
    server.use(
      http.post(HEYGEN_CREATE_URL, async ({ request }) => {
        observedCreateRequests.push({
          body: asRecord(await request.json()),
          idempotencyKey: request.headers.get("idempotency-key"),
        });
        expect(request.headers.get("x-api-key")).toBe("test-heygen-key");
        if (observedCreateRequests.length === 1) {
          return HttpResponse.json(
            { error: { message: "slow down" } },
            { status: 429, headers: { "retry-after": "0" } },
          );
        }
        return HttpResponse.json({
          data: {
            video_id: HEYGEN_VIDEO_ID,
            status: "pending",
            output_format: "webm",
          },
        });
      }),
      http.get(HEYGEN_STATUS_URL, () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return HttpResponse.json(
            { error: { message: "temporary provider outage" } },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          data:
            statusCalls === 2
              ? { id: HEYGEN_VIDEO_ID, status: "processing" }
              : {
                  id: HEYGEN_VIDEO_ID,
                  status: "completed",
                  video_url: HEYGEN_VIDEO_URL,
                  duration: 61,
                },
        });
      }),
      http.get(HEYGEN_VIDEO_URL, () => {
        videoDownloads += 1;
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/webm" },
        });
      }),
    );
    const app = createIntroVideoPresenterTestApp(
      fixture.usagePricingResolution,
    );
    const response = await app.request("/api/intro-video/presenter/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        avatarId: "Abigail_standing_office_front",
        audioUrl,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readGenerationId(
      await response.json(),
      fixture.userId,
    );
    expect(observedCreateRequests).toHaveLength(2);
    expect(observedCreateRequests[0]?.idempotencyKey).toBe(generationId);
    expect(observedCreateRequests[1]?.idempotencyKey).toBe(generationId);
    expect(observedCreateRequests[0]?.body).toStrictEqual(
      observedCreateRequests[1]?.body,
    );
    const createBody = observedCreateRequests[1]?.body;
    expect(createBody).toMatchObject({
      type: "avatar",
      engine: { type: "avatar_iii" },
      avatar_id: "Abigail_standing_office_front",
      audio_url: expect.stringMatching(/^https:\/\/r2\.example\.com\//u),
      aspect_ratio: "16:9",
      resolution: "1080p",
      output_format: "webm",
      callback_id: generationId,
      callback_url: expect.stringContaining(
        `/api/webhooks/built-in-generations/heygen/${generationId}?token=`,
      ),
    });
    expect(createBody).not.toHaveProperty("voice_id");
    expect(createBody).not.toHaveProperty("script");
    expect(createBody).not.toHaveProperty("background");
    const callbackUrl = new URL(String(createBody?.callback_url));

    for (let index = 0; index < 2; index += 1) {
      const additionalResponse = await app.request(
        "/api/intro-video/presenter/generate",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            avatarId: "Abigail_standing_office_front",
            audioUrl,
          }),
        },
      );
      expect(additionalResponse.status).toBe(202);
    }
    const limitedResponse = await accept(
      introVideoPresenterClient(fixture.usagePricingResolution).generate({
        headers: { authorization: `Bearer ${token}` },
        body: {
          avatarId: "Abigail_standing_office_front",
          audioUrl,
        },
      }),
      [429],
    );
    expect(limitedResponse.body).toMatchObject({
      error: { code: "BUILT_IN_RUN_CONCURRENCY_LIMIT" },
    });
    expect(observedCreateRequests).toHaveLength(4);

    const invalidCallback = new URL(callbackUrl);
    invalidCallback.searchParams.set("token", "invalid");
    const invalidResponse = await app.request(
      `${invalidCallback.pathname}${invalidCallback.search}`,
      { method: "POST", body: "{}" },
    );
    expect(invalidResponse.status).toBe(401);

    const providerUnavailableResponse = await app.request(
      `${callbackUrl.pathname}${callbackUrl.search}`,
      { method: "POST", body: "{}" },
    );
    expect(providerUnavailableResponse.status).toBe(503);
    const activeStatusResponse = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(activeStatusResponse.status).toBe(200);
    expect(asRecord(await activeStatusResponse.json()).status).toBe("running");

    const pendingResponse = await app.request(
      `${callbackUrl.pathname}${callbackUrl.search}`,
      { method: "POST", body: "{}" },
    );
    expect(pendingResponse.status).toBe(503);

    const completedResponse = await app.request(
      `${callbackUrl.pathname}${callbackUrl.search}`,
      { method: "POST", body: "{}" },
    );
    expect(completedResponse.status).toBe(200);
    await flushWaitUntilForTest();

    const status = await app.request(
      `/api/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(status.status).toBe(200);
    const statusBody = asRecord(await status.json());
    expect(statusBody.status).toBe("completed");
    expect(statusBody.result).toStrictEqual({
      id: expect.any(String),
      filename: expect.stringMatching(/^intro-video-presenter-.*\.webm$/u),
      contentType: "video/webm",
      size: VIDEO_BYTES.byteLength,
      url: expect.any(String),
      durationSeconds: 61,
      creditsCharged: 1271,
      avatarId: "Abigail_standing_office_front",
    });
    expect(videoDownloads).toBe(1);
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return (
          command instanceof PutObjectCommand &&
          command.input.ContentType === "video/webm" &&
          command.input.Metadata?.["public-brand"] === "okou"
        );
      }),
    ).toBeTruthy();

    mocks.clerk.session(fixture.userId, fixture.orgId);
    for (const query of ["", "?kind=avatar", "?kind=file", "?kind=video"]) {
      const catalogResponse = await app.request(
        `/api/artifacts/catalog${query}`,
        { headers: authHeaders() },
      );
      expect(catalogResponse.status).toBe(200);
      expect(asRecord(await catalogResponse.json()).artifacts).toStrictEqual(
        [],
      );
    }

    const duplicateResponse = await app.request(
      `${callbackUrl.pathname}${callbackUrl.search}`,
      { method: "POST", body: "{}" },
    );
    expect(duplicateResponse.status).toBe(200);
    await flushWaitUntilForTest();
    expect(videoDownloads).toBe(1);
    await expect(orgCredits(fixture)).resolves.toBe(8729);
  });
});
