import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../app-factory";
import { builtInGenerationJobs } from "@vm0/db/schema/built-in-generation-job";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  BYTEPLUS_VIDEO_TASKS_URL,
  VIDEO_IO_MODEL,
} from "../../services/zero-video-io-generate.service";
import { builtInGenerationUsageIdempotencyKey } from "../../services/built-in-generation-usage-idempotency";
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
import { clearAllDetached } from "../../utils";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const TEST_BUCKET = "test-user-artifacts";
const VIDEO_BYTES = Buffer.from("fake video bytes");
const BYTEPLUS_VIDEO_URL =
  "https://ark-content.byteplus.example/files/video-output.mp4";
const FAL_VEO_FAST_MODEL = "fal-ai/veo3.1/fast";
const FAL_VEO_FAST_QUEUE_URL = `https://queue.fal.run/${FAL_VEO_FAST_MODEL}`;
const FAL_STATUS_URL =
  "https://queue.fal.run/fal-ai/veo3.1/fast/requests/video-request/status";
const FAL_RESPONSE_URL =
  "https://queue.fal.run/fal-ai/veo3.1/fast/requests/video-request/response";
const FAL_VIDEO_URL = "https://v3b.fal.media/files/video-output.mp4";
const KLING_V3_4K_MODEL = "fal-ai/kling-video/v3/4k/text-to-video";
const KLING_V3_4K_QUEUE_URL = `https://queue.fal.run/${KLING_V3_4K_MODEL}`;
const KLING_STATUS_URL =
  "https://queue.fal.run/fal-ai/kling-video/v3/4k/text-to-video/requests/kling-video-request/status";
const KLING_RESPONSE_URL =
  "https://queue.fal.run/fal-ai/kling-video/v3/4k/text-to-video/requests/kling-video-request/response";
const KLING_VIDEO_URL = "https://v3b.fal.media/files/kling-output.mp4";
const WEB_ORIGIN = "https://www.vm0.test";

const VIDEO_PRICING_DEFAULTS = [
  {
    provider: "dreamina-seedance-2-0-260128",
    category: "output_video_tokens.480p_720p.no_video",
    unitPrice: 14_000,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-260128",
    category: "output_video_tokens.480p_720p.with_video",
    unitPrice: 8600,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-260128",
    category: "output_video_tokens.1080p.no_video",
    unitPrice: 15_400,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-260128",
    category: "output_video_tokens.1080p.with_video",
    unitPrice: 9400,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-fast-260128",
    category: "output_video_tokens.480p_720p.no_video",
    unitPrice: 11_200,
    unitSize: 1_000_000,
  },
  {
    provider: "dreamina-seedance-2-0-fast-260128",
    category: "output_video_tokens.480p_720p.with_video",
    unitPrice: 6600,
    unitSize: 1_000_000,
  },
  {
    provider: "seedance-1-5-pro-251215",
    category: "output_video_tokens.audio",
    unitPrice: 4800,
    unitSize: 1_000_000,
  },
  {
    provider: "seedance-1-5-pro-251215",
    category: "output_video_tokens.silent",
    unitPrice: 2400,
    unitSize: 1_000_000,
  },
  {
    provider: FAL_VEO_FAST_MODEL,
    category: "output_video_seconds.audio",
    unitPrice: 180,
    unitSize: 1,
  },
  {
    provider: FAL_VEO_FAST_MODEL,
    category: "output_video_seconds.silent",
    unitPrice: 120,
    unitSize: 1,
  },
  {
    provider: FAL_VEO_FAST_MODEL,
    category: "output_video_seconds.audio.4k",
    unitPrice: 420,
    unitSize: 1,
  },
  {
    provider: FAL_VEO_FAST_MODEL,
    category: "output_video_seconds.silent.4k",
    unitPrice: 360,
    unitSize: 1,
  },
  {
    provider: KLING_V3_4K_MODEL,
    category: "output_video_seconds.audio.4k",
    unitPrice: 504,
    unitSize: 1,
  },
  {
    provider: KLING_V3_4K_MODEL,
    category: "output_video_seconds.silent.4k",
    unitPrice: 504,
    unitSize: 1,
  },
] as const;

type VideoPricingDefault = (typeof VIDEO_PRICING_DEFAULTS)[number];
type VideoPricingCategory = VideoPricingDefault["category"];

interface VideoFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface PricingSnapshot {
  readonly provider: string;
  readonly category: VideoPricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
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

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Expected record");
}

function readCallbackUrl(body: unknown): string {
  const value = asRecord(body).callback_url;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error("Expected BytePlus callback_url");
}

async function postBytePlusWebhook(
  app: ReturnType<typeof createApp>,
  callbackUrl: string,
  payload: unknown,
): Promise<void> {
  const url = new URL(callbackUrl);
  const response = await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
}

function readFalWebhookUrl(requestUrl: string | null): string {
  if (requestUrl) {
    const webhookUrl = new URL(requestUrl).searchParams.get("fal_webhook");
    if (webhookUrl) {
      return webhookUrl;
    }
  }
  throw new Error("Expected Fal request fal_webhook query parameter");
}

async function postFalWebhook(
  app: ReturnType<typeof createApp>,
  requestUrl: string | null,
  payload: unknown,
): Promise<void> {
  const url = new URL(readFalWebhookUrl(requestUrl));
  const response = await app.request(`${url.pathname}${url.search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "COMPLETED", payload }),
  });
  expect(response.status).toBe(200);
}

function readAcceptedGenerationId(
  body: unknown,
  type: "video",
  userId: string,
): string {
  if (
    typeof body !== "object" ||
    body === null ||
    !("generationId" in body) ||
    typeof body.generationId !== "string"
  ) {
    throw new Error("Expected accepted generation response");
  }
  expect(body).toMatchObject({
    generationId: body.generationId,
    type,
    status: "queued",
    realtime: {
      channelName: `user:${userId}`,
      eventName: `built-in-generation:${body.generationId}`,
      tokenRequest: {
        keyName: "test-key",
        timestamp: 1_700_000_000_000,
        capability: '{"user:test-user":["subscribe"]}',
        clientId: "test-user",
        nonce: "test-nonce",
        mac: "test-mac",
      },
    },
  });
  return body.generationId;
}

function readGenerationResult(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "result" in body) {
    return body.result;
  }
  throw new Error("Expected completed generation result");
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly "file:write"[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: args.capabilities ?? ["file:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function upsertDefaultVideoPricingRows(): Promise<void> {
  const writeDb = store.set(writeDb$);
  for (const row of VIDEO_PRICING_DEFAULTS) {
    await writeDb
      .insert(usagePricing)
      .values({
        kind: "video",
        provider: row.provider,
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      })
      .onConflictDoUpdate({
        target: [
          usagePricing.kind,
          usagePricing.provider,
          usagePricing.category,
        ],
        set: {
          unitPrice: row.unitPrice,
          unitSize: row.unitSize,
          updatedAt: sql`now()`,
        },
      });
  }
}

async function deleteDefaultModelPricingRows(): Promise<
  readonly PricingSnapshot[]
> {
  const writeDb = store.set(writeDb$);
  const categories = VIDEO_PRICING_DEFAULTS.filter((row) => {
    return row.provider === VIDEO_IO_MODEL;
  }).map((row) => {
    return row.category;
  });
  const rows = await writeDb
    .select({
      provider: usagePricing.provider,
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, VIDEO_IO_MODEL),
        inArray(usagePricing.category, categories),
      ),
    );

  await writeDb
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, VIDEO_IO_MODEL),
        inArray(usagePricing.category, categories),
      ),
    );

  return rows.map((row) => {
    return {
      provider: row.provider,
      category: row.category as VideoPricingCategory,
      unitPrice: row.unitPrice,
      unitSize: row.unitSize,
    };
  });
}

async function restoreVideoPricingRows(
  rows: readonly PricingSnapshot[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await store
    .set(writeDb$)
    .insert(usagePricing)
    .values(
      rows.map((row) => {
        return {
          kind: "video",
          provider: row.provider,
          category: row.category,
          unitPrice: row.unitPrice,
          unitSize: row.unitSize,
        };
      }),
    )
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: sql`excluded.unit_size`,
        updatedAt: sql`now()`,
      },
    });
}

async function seedVideoFixture(options: {
  readonly credits?: number;
  readonly withPricing?: boolean;
}): Promise<VideoFixture> {
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
    tier: "free",
    credits: options.credits ?? 10_000,
  });
  await writeDb.execute(sql`
    INSERT INTO org_members_metadata (org_id, user_id)
    VALUES (${orgId}, ${userId})
  `);

  if (options.withPricing) {
    await upsertDefaultVideoPricingRows();
  }

  return { orgId, userId };
}

async function deleteVideoFixture(fixture: VideoFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(builtInGenerationJobs)
    .where(eq(builtInGenerationJobs.orgId, fixture.orgId));
  await writeDb
    .delete(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.orgId, fixture.orgId),
        eq(runUploadedFiles.userId, fixture.userId),
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
}

describe("POST /api/zero/video-io/generate", () => {
  const track = createFixtureTracker<VideoFixture>(deleteVideoFixture);
  const trackPricing = createFixtureTracker<readonly PricingSnapshot[]>(
    restoreVideoPricingRows,
  );

  beforeEach(() => {
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
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

  it("returns 401 when not authenticated", async () => {
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a city at night" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("rejects unsupported durations before BytePlus", async () => {
    const fixture = await track(seedVideoFixture({ withPricing: true }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        calledBytePlus = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city", duration: "3s" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Unsupported video duration for dreamina-seedance-2.0-fast: 3s",
        code: "BAD_REQUEST",
      },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it("rejects BytePlus 4k requests before provider submission", async () => {
    const fixture = await track(seedVideoFixture({ withPricing: true }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        calledBytePlus = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a city",
        model: "dreamina-seedance-2.0",
        resolution: "4k",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Unsupported video resolution for dreamina-seedance-2.0: 4k",
        code: "BAD_REQUEST",
      },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it("returns 402 when the org has no spendable credits", async () => {
    const fixture = await track(seedVideoFixture({ credits: 0 }));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
  });

  it("returns 503 when video pricing is not configured", async () => {
    const fixture = await track(seedVideoFixture({ credits: 1000 }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await upsertDefaultVideoPricingRows();
    await trackPricing(deleteDefaultModelPricingRows());
    let calledBytePlus = false;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        calledBytePlus = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Video generation pricing is not configured",
        code: "NOT_CONFIGURED",
      },
    });
    expect(calledBytePlus).toBeFalsy();
  });

  it("generates video files with BytePlus and charges actual callback token usage", async () => {
    const fixture = await track(seedVideoFixture({ withPricing: true }));
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

    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          id: "byteplus-video-task",
          status: "queued",
        });
      }),
      http.get(BYTEPLUS_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a cinematic tracking shot through a neon market",
        duration: "8s",
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: true,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );

    const callbackUrl = readCallbackUrl(observedBody);
    await postBytePlusWebhook(app, callbackUrl, {
      id: "byteplus-video-task",
      model: VIDEO_IO_MODEL,
      status: "succeeded",
      content: {
        video_url: BYTEPLUS_VIDEO_URL,
      },
      usage: {
        completion_tokens: 123_456,
      },
    });
    await clearAllDetached();
    const webhookUrl = new URL(callbackUrl);
    expect(webhookUrl.origin).toBe(WEB_ORIGIN);
    expect(webhookUrl.pathname).toBe(
      `/api/webhooks/built-in-generations/byteplus/${generationId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "video",
        status: "completed",
      }),
    );

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const statusBody: unknown = await statusResponse.json();
    expect(statusBody).toMatchObject({
      generationId,
      type: "video",
      status: "completed",
    });
    const body = readGenerationResult(statusBody);
    expect(body).toMatchObject({
      contentType: "video/mp4",
      size: VIDEO_BYTES.byteLength,
      creditsCharged: 1383,
      model: VIDEO_IO_MODEL,
      aspectRatio: "16:9",
      duration: "8s",
      durationSeconds: 8,
      resolution: "720p",
      generateAudio: true,
      sourceUrl: BYTEPLUS_VIDEO_URL,
      requestId: "byteplus-video-task",
    });
    expect(observedAuthorization).toBe("Bearer test-byteplus-key");
    expect(observedBody).toMatchObject({
      model: VIDEO_IO_MODEL,
      content: [
        {
          type: "text",
          text: "a cinematic tracking shot through a neon market",
        },
      ],
      callback_url: callbackUrl,
      resolution: "720p",
      ratio: "16:9",
      duration: 8,
      generate_audio: true,
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body &&
        "url" in body
      )
    ) {
      throw new Error("Expected video response id, filename, and url");
    }
    const fileId = String(body.id);
    const filename = String(body.filename);
    const url = String(body.url);
    expect(filename).toBe(`video-${fileId.slice(0, 8)}.mp4`);
    expect(url).toBe(
      `https://cdn.vm7.io/artifacts/${encodeURIComponent(
        fixture.userId,
      )}/${fileId}/${filename}`,
    );

    const putInput = commandInput(context.mocks.s3.send.mock.calls[0]?.[0]);
    expect(putInput.Bucket).toBe(TEST_BUCKET);
    expect(putInput.Key).toBe(
      `artifacts/${fixture.userId}/${fileId}/${filename}`,
    );
    expect(putInput.ContentType).toBe("video/mp4");
    const putBody = putInput.Body;
    expect(Buffer.isBuffer(putBody)).toBeTruthy();
    if (!Buffer.isBuffer(putBody)) {
      throw new Error("Expected S3 put body to be a Buffer");
    }
    expect(putBody).toStrictEqual(VIDEO_BYTES);

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
      contentType: "video/mp4",
      sizeBytes: VIDEO_BYTES.byteLength,
      url,
    });
    expect(uploadRows[0]?.metadata).toMatchObject({
      generatedBy: "zero-official-video",
      model: VIDEO_IO_MODEL,
      sourceUrl: BYTEPLUS_VIDEO_URL,
      requestId: "byteplus-video-task",
      aspectRatio: "16:9",
      duration: "8s",
      durationSeconds: 8,
      resolution: "720p",
      generateAudio: true,
      billingQuantity: 123_456,
      s3Key: `artifacts/${fixture.userId}/${fileId}/${filename}`,
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "video"),
          eq(usageEvent.provider, VIDEO_IO_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      runId,
      idempotencyKey: builtInGenerationUsageIdempotencyKey({
        generationId,
        scope: "video",
        category: "output_video_tokens.480p_720p.no_video",
      }),
      category: "output_video_tokens.480p_720p.no_video",
      quantity: 123_456,
      creditsCharged: 1383,
      status: "processed",
      billingError: null,
    });
  });

  it("submits a single Dreamina first-frame image without a frame role", async () => {
    const fixture = await track(seedVideoFixture({ withPricing: true }));
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

    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "dreamina-video-task",
          status: "queued",
        });
      }),
      http.get(BYTEPLUS_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "animate the photo with natural motion",
        model: "dreamina-seedance-2.0",
        duration: "6s",
        resolution: "720p",
        aspectRatio: "4:3",
        firstFrameImageUrl: "https://example.com/first.png",
      }),
    });

    expect(response.status).toBe(202);
    const callbackUrl = readCallbackUrl(observedBody);

    await postBytePlusWebhook(app, callbackUrl, {
      id: "dreamina-video-task",
      status: "succeeded",
      content: {
        video_url: {
          url: BYTEPLUS_VIDEO_URL,
          content_type: "video/mp4",
        },
      },
      usage: {
        completion_tokens: 100_000,
      },
    });
    await clearAllDetached();

    expect(observedBody).toMatchObject({
      model: "dreamina-seedance-2-0-260128",
      resolution: "720p",
      ratio: "4:3",
      duration: 6,
      generate_audio: true,
      content: [
        {
          type: "text",
          text: "animate the photo with natural motion",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first.png" },
        },
      ],
    });
    const content = asRecord(observedBody).content;
    expect(Array.isArray(content)).toBeTruthy();
    if (!Array.isArray(content)) {
      throw new Error("Expected BytePlus content array");
    }
    expect(asRecord(content[1]).role).toBeUndefined();
  });

  it("submits multimodal Dreamina references and charges with-video pricing", async () => {
    const fixture = await track(seedVideoFixture({ credits: 10_000 }));
    await upsertDefaultVideoPricingRows();
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

    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, async ({ request }) => {
        observedBody = await request.json();
        return HttpResponse.json({
          id: "dreamina-video-task",
          status: "queued",
        });
      }),
      http.get(BYTEPLUS_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "preserve the character while matching the soundtrack",
        model: "dreamina-seedance-2.0",
        duration: "6s",
        resolution: "1080p",
        aspectRatio: "16:9",
        imageUrls: ["https://example.com/reference.png"],
        videoUrls: ["https://example.com/reference.mp4"],
        audioUrls: ["https://example.com/reference.mp3"],
        firstFrameImageUrl: "https://example.com/first.png",
        lastFrameImageUrl: "https://example.com/last.png",
        seed: 42,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );
    const callbackUrl = readCallbackUrl(observedBody);

    await postBytePlusWebhook(app, callbackUrl, {
      id: "dreamina-video-task",
      status: "succeeded",
      content: {
        video_url: {
          url: BYTEPLUS_VIDEO_URL,
          content_type: "video/mp4",
        },
      },
      usage: {
        completion_tokens: 200_000,
      },
    });
    await clearAllDetached();

    expect(observedBody).toMatchObject({
      model: "dreamina-seedance-2-0-260128",
      resolution: "1080p",
      ratio: "16:9",
      duration: 6,
      generate_audio: true,
      seed: 42,
      content: [
        {
          type: "text",
          text: "preserve the character while matching the soundtrack",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first.png" },
          role: "first_frame",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/last.png" },
          role: "last_frame",
        },
        {
          type: "image_url",
          image_url: { url: "https://example.com/reference.png" },
          role: "reference_image",
        },
        {
          type: "video_url",
          video_url: { url: "https://example.com/reference.mp4" },
          role: "reference_video",
        },
        {
          type: "audio_url",
          audio_url: { url: "https://example.com/reference.mp3" },
          role: "reference_audio",
        },
      ],
    });

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      creditsCharged: 1880,
      model: "dreamina-seedance-2-0-260128",
      sourceUrl: BYTEPLUS_VIDEO_URL,
      requestId: "dreamina-video-task",
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "video"),
          eq(usageEvent.provider, "dreamina-seedance-2-0-260128"),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      category: "output_video_tokens.1080p.with_video",
      quantity: 200_000,
      creditsCharged: 1880,
      status: "processed",
      billingError: null,
    });
  });

  it("generates video files with the recommended Fal fallback model", async () => {
    const fixture = await track(seedVideoFixture({ withPricing: true }));
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

    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_VEO_FAST_QUEUE_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json({
          request_id: "video-request",
          status_url: FAL_STATUS_URL,
          response_url: FAL_RESPONSE_URL,
        });
      }),
      http.get(FAL_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a cinematic tracking shot through a neon market",
        model: "veo3.1-fast",
        duration: "8s",
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: true,
        seed: 42,
        negativePrompt: "low quality",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      video: {
        url: FAL_VIDEO_URL,
        content_type: "video/mp4",
        file_name: "output.mp4",
        file_size: VIDEO_BYTES.byteLength,
      },
    });
    await clearAllDetached();

    const webhookUrl = new URL(readFalWebhookUrl(observedRequestUrl));
    expect(webhookUrl.origin).toBe(WEB_ORIGIN);
    expect(webhookUrl.pathname).toBe(
      `/api/webhooks/built-in-generations/fal/${generationId}`,
    );
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a cinematic tracking shot through a neon market",
      aspect_ratio: "16:9",
      duration: "8s",
      resolution: "720p",
      generate_audio: true,
      auto_fix: true,
      safety_tolerance: "4",
      negative_prompt: "low quality",
      seed: 42,
    });

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "video/mp4",
      size: VIDEO_BYTES.byteLength,
      creditsCharged: 1440,
      model: FAL_VEO_FAST_MODEL,
      sourceUrl: FAL_VIDEO_URL,
      requestId: "video-request",
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "video"),
          eq(usageEvent.provider, FAL_VEO_FAST_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      category: "output_video_seconds.audio",
      quantity: 8,
      creditsCharged: 1440,
      status: "processed",
      billingError: null,
    });
  });

  it("generates video files with the recommended Kling 4K model", async () => {
    const fixture = await track(seedVideoFixture({ withPricing: true }));
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

    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(KLING_V3_4K_QUEUE_URL, async ({ request }) => {
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json({
          request_id: "kling-video-request",
          status_url: KLING_STATUS_URL,
          response_url: KLING_RESPONSE_URL,
        });
      }),
      http.get(KLING_VIDEO_URL, () => {
        return new HttpResponse(VIDEO_BYTES, {
          headers: { "content-type": "video/mp4" },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a vertical concert stage reveal",
        model: "kling-v3-4k",
        duration: "5s",
        aspectRatio: "9:16",
        generateAudio: true,
        negativePrompt: "low quality",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "video",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      video: {
        url: KLING_VIDEO_URL,
        content_type: "video/mp4",
      },
    });
    await clearAllDetached();

    expect(observedBody).toMatchObject({
      prompt: "a vertical concert stage reveal",
      aspect_ratio: "9:16",
      duration: "5",
      generate_audio: true,
      negative_prompt: "low quality",
    });

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      creditsCharged: 2520,
      model: KLING_V3_4K_MODEL,
      resolution: "4k",
      sourceUrl: KLING_VIDEO_URL,
      requestId: "kling-video-request",
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "video"),
          eq(usageEvent.provider, KLING_V3_4K_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      category: "output_video_seconds.audio.4k",
      quantity: 5,
      creditsCharged: 2520,
      status: "processed",
      billingError: null,
    });
  });

  it("records a failed job when BytePlus video generation fails", async () => {
    const fixture = await track(
      seedVideoFixture({ credits: 1000, withPricing: true }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(BYTEPLUS_VIDEO_TASKS_URL, () => {
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Video generation failed",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
    const jobRows = await store
      .set(writeDb$)
      .select()
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.orgId, fixture.orgId));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({
      type: "video",
      status: "failed",
      error: {
        message: "Video generation failed",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${jobRows[0]?.id}`,
      expect.objectContaining({
        generationId: jobRows[0]?.id,
        type: "video",
        status: "failed",
      }),
    );
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});
