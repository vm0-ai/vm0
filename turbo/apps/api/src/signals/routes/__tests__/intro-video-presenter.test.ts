import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
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
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { seedCompose$, seedRun$ } from "./helpers/usage-state";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const TEST_BUCKET = "test-user-artifacts";

const HEYGEN_CREATE_URL = "https://api.heygen.com/v3/videos";
const HEYGEN_VIDEO_ID = "heygen-video-123";
const HEYGEN_STATUS_URL = `${HEYGEN_CREATE_URL}/${HEYGEN_VIDEO_ID}`;
const HEYGEN_VIDEO_URL = "https://files.heygen.test/presenter.webm";
const VIDEO_BYTES = Buffer.from("generated intro video presenter");
const PRICING_ROWS = [
  {
    kind: "video",
    provider: "heygen-avatar-iv",
    category: "output_video_seconds",
    unitPrice: 5000,
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

  it("renders a curated presenter through HeyGen v3 idempotently", async () => {
    const fixture = await seedFixture();
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
        return HttpResponse.json({
          data:
            statusCalls === 1
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
    expect(createBody).not.toHaveProperty("engine");
    expect(createBody).not.toHaveProperty("voice_id");
    expect(createBody).not.toHaveProperty("script");
    expect(createBody).not.toHaveProperty("background");
    const callbackUrl = new URL(String(createBody?.callback_url));

    const invalidCallback = new URL(callbackUrl);
    invalidCallback.searchParams.set("token", "invalid");
    const invalidResponse = await app.request(
      `${invalidCallback.pathname}${invalidCallback.search}`,
      { method: "POST", body: "{}" },
    );
    expect(invalidResponse.status).toBe(401);

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
      creditsCharged: 5084,
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
    for (const kind of ["avatar", "file", "video"] as const) {
      const catalogResponse = await app.request(
        `/api/artifacts/catalog?kind=${kind}`,
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
    await expect(orgCredits(fixture)).resolves.toBe(4916);
  });
});
