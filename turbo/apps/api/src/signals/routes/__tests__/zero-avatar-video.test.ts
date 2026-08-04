import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { zeroAvatarVideoRoutes } from "../zero-avatar-video";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroBuiltInGenerationRoutes } from "../zero-built-in-generation";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const JOGGAI_CREATE_URL = "https://api.jogg.ai/v2/create_video_from_avatar";
const JOGGAI_AVATARS_URL = "https://api.jogg.ai/v2/avatars/public";
const JOGGAI_VOICES_URL = "https://api.jogg.ai/v2/voices";
const GENERATED_VIDEO_URL = "https://res.jogg.ai/avatar-video.mp4";
const WEB_ORIGIN = "https://www.vm0.test";
const VIDEO_BYTES = Buffer.from("generated avatar video");

interface AvatarVideoFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createAvatarVideoTestApp() {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...zeroAvatarVideoRoutes,
      ...zeroBuiltInGenerationRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...zeroBillingStatusRoutes,
    ],
  });
}

async function seedAvatarVideoFixture(options?: {
  readonly featureEnabled?: boolean;
  readonly withPricing?: boolean;
}): Promise<AvatarVideoFixture> {
  const fixture = {
    orgId: `org_${randomUUID()}`,
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
  if (options?.featureEnabled ?? true) {
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.JoggAiBuiltIn]: true,
    });
  }
  if (options?.withPricing ?? true) {
    await seedUsagePricingRows([
      {
        kind: "video",
        provider: "joggai-talking-avatar",
        category: "output_video_joggai_credits",
        unitPrice: 599,
        unitSize: 1,
      },
    ]);
  }
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
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

function readWebhookUrl(value: unknown): URL {
  const webhookUrl = asRecord(value).webhook_url;
  if (typeof webhookUrl !== "string") {
    throw new Error("Expected JoggAI webhook URL");
  }
  return new URL(webhookUrl);
}

async function orgCredits(fixture: AvatarVideoFixture): Promise<number> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const response = await createAvatarVideoTestApp().request(
    "/api/zero/billing/status",
    { headers: authHeaders() },
  );
  expect(response.status).toBe(200);
  const body = asRecord(await response.json());
  if (typeof body.credits !== "number") {
    throw new Error("Expected numeric credit balance");
  }
  return body.credits;
}

describe("JoggAI built-in avatar video routes", () => {
  beforeEach(() => {
    mockEnv("VM0_API_BACKEND_URL", WEB_ORIGIN);
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    mockEnv("JOGGAI_API_KEY", "test-joggai-key");
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

  it("keeps the built-in capability behind its feature switch", async () => {
    const fixture = await seedAvatarVideoFixture({ featureEnabled: false });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await createAvatarVideoTestApp().request(
      "/api/zero/avatar-video/generate",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          avatarId: 81,
          voiceId: "en-US-ChristopherNeural",
          script: "Hello",
        }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Built-in JoggAI avatar video generation is not enabled for this workspace.",
        code: "FEATURE_DISABLED",
      },
    });
  });

  it("lists and normalizes public avatars and voices", async () => {
    const fixture = await seedAvatarVideoFixture();
    const observedUrls: string[] = [];
    server.use(
      http.get(JOGGAI_AVATARS_URL, ({ request }) => {
        observedUrls.push(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-joggai-key");
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: {
            avatars: [
              {
                id: 81,
                name: "Ada",
                video_url: "https://res.jogg.ai/ada.mp4",
                cover_url: "https://res.jogg.ai/ada.jpg",
                aspect_ratio: 1,
                style: "professional",
                gender: "female",
                age: "adult",
              },
            ],
          },
        });
      }),
      http.get(JOGGAI_VOICES_URL, ({ request }) => {
        observedUrls.push(request.url);
        expect(request.headers.get("x-api-key")).toBe("test-joggai-key");
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: {
            voices: [
              {
                voice_id: "en-US-ChristopherNeural",
                name: "Christopher",
                audio_url: "https://res.jogg.ai/christopher.mp3",
                language: "english",
                gender: "male",
                age: "young",
                accent: "american",
                use_case: "narrative_story",
              },
            ],
            has_more: true,
          },
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createAvatarVideoTestApp();

    const avatars = await app.request(
      "/api/zero/avatar-video/avatars?page=2&pageSize=20&aspectRatio=portrait&style=professional",
      { headers: authHeaders() },
    );
    expect(avatars.status).toBe(200);
    await expect(avatars.json()).resolves.toStrictEqual({
      avatars: [
        {
          id: 81,
          name: "Ada",
          videoUrl: "https://res.jogg.ai/ada.mp4",
          coverUrl: "https://res.jogg.ai/ada.jpg",
          aspectRatio: 1,
          style: "professional",
          gender: "female",
          age: "adult",
        },
      ],
    });

    const voices = await app.request(
      "/api/zero/avatar-video/voices?page=3&pageSize=25&language=english&gender=male",
      { headers: authHeaders() },
    );
    expect(voices.status).toBe(200);
    await expect(voices.json()).resolves.toStrictEqual({
      voices: [
        {
          id: "en-US-ChristopherNeural",
          name: "Christopher",
          sampleUrl: "https://res.jogg.ai/christopher.mp3",
          language: "english",
          gender: "male",
          age: "young",
          accent: "american",
          useCase: "narrative_story",
        },
      ],
      hasMore: true,
    });

    expect(new URL(observedUrls[0] ?? "").searchParams.toString()).toBe(
      "page=2&page_size=20&aspect_ratio=portrait&style=professional",
    );
    expect(new URL(observedUrls[1] ?? "").searchParams.toString()).toBe(
      "page=3&page_size=25&gender=male&language=english",
    );
  });

  it("acknowledges, stores, and bills a talking-avatar video webhook", async () => {
    const fixture = await seedAvatarVideoFixture();
    const videoDownloadStarted = createDeferredPromise<void>(context.signal);
    const releaseVideoDownload = createDeferredPromise<void>(context.signal);
    let observedBody: unknown = null;
    let observedApiKey: string | null = null;
    server.use(
      http.post(JOGGAI_CREATE_URL, async ({ request }) => {
        observedApiKey = request.headers.get("x-api-key");
        observedBody = await request.json();
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: { video_id: "jogg-video-123" },
        });
      }),
      http.get(GENERATED_VIDEO_URL, async () => {
        videoDownloadStarted.resolve(undefined);
        await releaseVideoDownload.promise;
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createAvatarVideoTestApp();
    const response = await app.request("/api/zero/avatar-video/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        avatarId: 81,
        voiceId: "en-US-ChristopherNeural",
        script: "Welcome to vm0",
        aspectRatio: "landscape",
        screenStyle: 2,
        caption: false,
        videoName: "vm0 introduction",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readGenerationId(
      await response.json(),
      fixture.userId,
    );
    expect(observedApiKey).toBe("test-joggai-key");
    expect(observedBody).toMatchObject({
      avatar: { avatar_type: 0, avatar_id: 81 },
      voice: {
        type: "script",
        voice_id: "en-US-ChristopherNeural",
        script: "Welcome to vm0",
      },
      aspect_ratio: "landscape",
      screen_style: 2,
      caption: false,
      video_name: "vm0 introduction",
    });

    const webhookUrl = readWebhookUrl(observedBody);
    expect(webhookUrl.origin).toBe(WEB_ORIGIN);
    expect(webhookUrl.pathname).toBe(
      `/api/webhooks/built-in-generations/joggai/${generationId}`,
    );
    const webhookResponse = await app.request(
      `${webhookUrl.pathname}${webhookUrl.search}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_id: "event-1",
          event: "generated_avatar_video_success",
          timestamp: 1_700_000_000,
          data: {
            video_id: "jogg-video-123",
            status: "completed",
            video_url: GENERATED_VIDEO_URL,
            cover_url: "https://res.jogg.ai/avatar-video.jpg",
            duration: 121,
          },
        }),
      },
    );
    expect(webhookResponse.status).toBe(200);
    await videoDownloadStarted.promise;
    releaseVideoDownload.resolve(undefined);
    await flushWaitUntilForTest();

    const status = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(status.status).toBe(200);
    const statusBody = asRecord(await status.json());
    expect(statusBody.status).toBe("completed");
    expect(statusBody.result).toMatchObject({
      contentType: "video/mp4",
      size: VIDEO_BYTES.byteLength,
      durationSeconds: 121,
      creditsCharged: 1198,
      provider: "joggai",
      model: "joggai-talking-avatar",
      providerVideoId: "jogg-video-123",
      avatarId: 81,
      voiceId: "en-US-ChristopherNeural",
      inputType: "script",
      aspectRatio: "landscape",
      screenStyle: 2,
      caption: false,
      sourceUrl: GENERATED_VIDEO_URL,
    });
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return command instanceof PutObjectCommand;
      }),
    ).toBeTruthy();
    await expect(orgCredits(fixture)).resolves.toBe(8802);
  });

  it("maps audio input without exposing private JoggAI resources", async () => {
    const fixture = await seedAvatarVideoFixture();
    let observedBody: unknown = null;
    server.use(
      http.post(JOGGAI_CREATE_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          code: 0,
          msg: "Success",
          data: { video_id: "jogg-audio-video" },
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await createAvatarVideoTestApp().request(
      "/api/zero/avatar-video/generate",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          avatarId: 82,
          voiceId: "en-US-AvaNeural",
          audioUrl: "https://example.com/voice.mp3",
        }),
      },
    );

    expect(response.status).toBe(202);
    expect(observedBody).toMatchObject({
      avatar: { avatar_type: 0, avatar_id: 82 },
      voice: {
        type: "audio",
        voice_id: "en-US-AvaNeural",
        audio_url: "https://example.com/voice.mp3",
      },
      aspect_ratio: "portrait",
      screen_style: 1,
      caption: true,
    });
  });
});
