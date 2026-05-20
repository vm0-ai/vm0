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
  FAL_VIDEO_QUEUE_URL,
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
const SEEDANCE_FAST_MODEL = "bytedance/seedance-2.0/fast/text-to-video";
const SEEDANCE_FAST_QUEUE_URL = `https://queue.fal.run/${SEEDANCE_FAST_MODEL}`;
const SEEDANCE_STATUS_URL =
  "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video/requests/seedance-video-request/status";
const SEEDANCE_RESPONSE_URL =
  "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video/requests/seedance-video-request/response";
const SEEDANCE_VIDEO_URL = "https://v3b.fal.media/files/seedance-output.mp4";
const WEB_ORIGIN = "https://www.vm0.test";
const VIDEO_SECOND_PRICING_CATEGORIES = [
  "output_video_seconds.audio",
  "output_video_seconds.silent",
  "output_video_seconds.audio.4k",
  "output_video_seconds.silent.4k",
] as const;
const VIDEO_PRICING_CATEGORIES = [
  ...VIDEO_SECOND_PRICING_CATEGORIES,
  "output_video_tokens",
] as const;

const tokenRequest = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: '{"user:test-user":["subscribe"]}',
  clientId: "test-user",
  nonce: "test-nonce",
  mac: "test-mac",
});

type VideoPricingCategory = (typeof VIDEO_PRICING_CATEGORIES)[number];

interface VideoFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly insertedPricingCategories: readonly VideoPricingCategory[];
}

interface PricingSnapshot {
  readonly category: VideoPricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface ProviderPricingSnapshot extends PricingSnapshot {
  readonly provider: string;
  readonly existed: boolean;
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

function readWebhookUrl(requestUrl: string | null): string {
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
  const url = new URL(readWebhookUrl(requestUrl));
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
      tokenRequest,
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

function isVideoPricingCategory(value: string): value is VideoPricingCategory {
  return VIDEO_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

async function ensureVideoPricing(): Promise<{
  readonly pricing: ReadonlyMap<VideoPricingCategory, PricingSnapshot>;
  readonly insertedCategories: readonly VideoPricingCategory[];
}> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, VIDEO_IO_MODEL),
        inArray(usagePricing.category, [...VIDEO_SECOND_PRICING_CATEGORIES]),
      ),
    );

  const pricing = new Map<VideoPricingCategory, PricingSnapshot>();
  for (const row of rows) {
    if (isVideoPricingCategory(row.category)) {
      pricing.set(row.category, {
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }

  const defaults: Readonly<
    Record<(typeof VIDEO_SECOND_PRICING_CATEGORIES)[number], PricingSnapshot>
  > = {
    "output_video_seconds.audio": {
      category: "output_video_seconds.audio",
      unitPrice: 180,
      unitSize: 1,
    },
    "output_video_seconds.silent": {
      category: "output_video_seconds.silent",
      unitPrice: 120,
      unitSize: 1,
    },
    "output_video_seconds.audio.4k": {
      category: "output_video_seconds.audio.4k",
      unitPrice: 420,
      unitSize: 1,
    },
    "output_video_seconds.silent.4k": {
      category: "output_video_seconds.silent.4k",
      unitPrice: 360,
      unitSize: 1,
    },
  };

  const insertedCategories: VideoPricingCategory[] = [];
  for (const category of VIDEO_SECOND_PRICING_CATEGORIES) {
    if (!pricing.has(category)) {
      const row = defaults[category];
      await writeDb.insert(usagePricing).values({
        kind: "video",
        provider: VIDEO_IO_MODEL,
        category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
      pricing.set(category, row);
      insertedCategories.push(category);
    }
  }

  return { pricing, insertedCategories };
}

async function deleteVideoPricingRows(): Promise<readonly PricingSnapshot[]> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, VIDEO_IO_MODEL),
        inArray(usagePricing.category, [...VIDEO_SECOND_PRICING_CATEGORIES]),
      ),
    );

  await writeDb
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, VIDEO_IO_MODEL),
        inArray(usagePricing.category, [...VIDEO_SECOND_PRICING_CATEGORIES]),
      ),
    );

  return rows.filter((row): row is PricingSnapshot => {
    return isVideoPricingCategory(row.category);
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
          provider: VIDEO_IO_MODEL,
          category: row.category,
          unitPrice: row.unitPrice,
          unitSize: row.unitSize,
        };
      }),
    );
}

async function upsertVideoPricingRow(args: {
  readonly provider: string;
  readonly category: VideoPricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}): Promise<ProviderPricingSnapshot> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "video"),
        eq(usagePricing.provider, args.provider),
        eq(usagePricing.category, args.category),
      ),
    );
  const existing = rows[0];

  await writeDb
    .insert(usagePricing)
    .values({
      kind: "video",
      provider: args.provider,
      category: args.category,
      unitPrice: args.unitPrice,
      unitSize: args.unitSize,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: args.unitPrice,
        unitSize: args.unitSize,
        updatedAt: sql`now()`,
      },
    });

  return {
    provider: args.provider,
    category: args.category,
    unitPrice: existing?.unitPrice ?? args.unitPrice,
    unitSize: existing?.unitSize ?? args.unitSize,
    existed: existing !== undefined,
  };
}

async function restoreVideoPricingRow(
  snapshot: ProviderPricingSnapshot,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  if (!snapshot.existed) {
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "video"),
          eq(usagePricing.provider, snapshot.provider),
          eq(usagePricing.category, snapshot.category),
        ),
      );
    return;
  }

  await writeDb
    .insert(usagePricing)
    .values({
      kind: "video",
      provider: snapshot.provider,
      category: snapshot.category,
      unitPrice: snapshot.unitPrice,
      unitSize: snapshot.unitSize,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: snapshot.unitPrice,
        unitSize: snapshot.unitSize,
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
    INSERT INTO org_members_metadata (org_id, user_id, credit_enabled)
    VALUES (${orgId}, ${userId}, true)
  `);

  const pricing = options.withPricing
    ? await ensureVideoPricing()
    : { insertedCategories: [] };

  return {
    orgId,
    userId,
    insertedPricingCategories: pricing.insertedCategories,
  };
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
  if (fixture.insertedPricingCategories.length > 0) {
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "video"),
          eq(usagePricing.provider, VIDEO_IO_MODEL),
          inArray(usagePricing.category, [
            ...fixture.insertedPricingCategories,
          ]),
        ),
      );
  }
}

describe("POST /api/zero/video-io/generate", () => {
  const track = createFixtureTracker<VideoFixture>(deleteVideoFixture);
  const trackPricing = createFixtureTracker<readonly PricingSnapshot[]>(
    restoreVideoPricingRows,
  );
  const trackPricingRow = createFixtureTracker<ProviderPricingSnapshot>(
    restoreVideoPricingRow,
  );

  beforeEach(() => {
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
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

  it("rejects unsupported durations before fal", async () => {
    const fixture = await track(seedVideoFixture({ withPricing: true }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledFal = false;
    server.use(
      http.post(FAL_VIDEO_QUEUE_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/video-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a city", duration: "10s" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Unsupported video duration for veo3.1-fast: 10s",
        code: "BAD_REQUEST",
      },
    });
    expect(calledFal).toBeFalsy();
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
    await trackPricing(deleteVideoPricingRows());
    let calledFal = false;
    server.use(
      http.post(FAL_VIDEO_QUEUE_URL, () => {
        calledFal = true;
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
    expect(calledFal).toBeFalsy();
  });

  it("generates video files with fal and charges configured pricing", async () => {
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
      http.post(FAL_VIDEO_QUEUE_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json({
          request_id: "video-request",
          status_url: FAL_STATUS_URL,
          response_url: FAL_RESPONSE_URL,
        });
      }),
      http.get(FAL_STATUS_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Key test-fal-key");
        return HttpResponse.json({
          status: "COMPLETED",
          response_url: FAL_RESPONSE_URL,
        });
      }),
      http.get(FAL_RESPONSE_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Key test-fal-key");
        return HttpResponse.json({
          video: {
            url: FAL_VIDEO_URL,
            content_type: "video/mp4",
            file_name: "output.mp4",
            file_size: VIDEO_BYTES.byteLength,
          },
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

    await postFalWebhook(app, observedRequestUrl, {
      video: {
        url: FAL_VIDEO_URL,
        content_type: "video/mp4",
        file_name: "output.mp4",
        file_size: VIDEO_BYTES.byteLength,
      },
    });
    await clearAllDetached();
    const webhookUrl = new URL(readWebhookUrl(observedRequestUrl));
    expect(webhookUrl.origin).toBe(WEB_ORIGIN);
    expect(webhookUrl.pathname).toBe(
      `/api/webhooks/built-in-generations/fal/${generationId}`,
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
      creditsCharged: 1440,
      model: VIDEO_IO_MODEL,
      aspectRatio: "16:9",
      duration: "8s",
      durationSeconds: 8,
      resolution: "720p",
      generateAudio: true,
      sourceUrl: FAL_VIDEO_URL,
      requestId: "video-request",
    });
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a cinematic tracking shot through a neon market",
      aspect_ratio: "16:9",
      duration: "8s",
      resolution: "720p",
      generate_audio: true,
      auto_fix: true,
      safety_tolerance: "4",
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
      sourceUrl: FAL_VIDEO_URL,
      requestId: "video-request",
      aspectRatio: "16:9",
      duration: "8s",
      durationSeconds: 8,
      resolution: "720p",
      generateAudio: true,
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
        category: "output_video_seconds.audio",
      }),
      category: "output_video_seconds.audio",
      quantity: 8,
      creditsCharged: 1440,
      status: "processed",
      billingError: null,
    });
  });

  it("generates video files with a selected fal video model", async () => {
    const fixture = await track(seedVideoFixture({ credits: 10_000 }));
    await trackPricingRow(
      upsertVideoPricingRow({
        provider: KLING_V3_4K_MODEL,
        category: "output_video_seconds.audio.4k",
        unitPrice: 504,
        unitSize: 1,
      }),
    );
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
      http.get(KLING_STATUS_URL, () => {
        return HttpResponse.json({
          status: "COMPLETED",
          response_url: KLING_RESPONSE_URL,
        });
      }),
      http.get(KLING_RESPONSE_URL, () => {
        return HttpResponse.json({
          video: {
            url: KLING_VIDEO_URL,
            content_type: "video/mp4",
            file_name: "kling-output.mp4",
            file_size: VIDEO_BYTES.byteLength,
          },
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
        file_name: "kling-output.mp4",
        file_size: VIDEO_BYTES.byteLength,
      },
    });
    await clearAllDetached();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "video/mp4",
      size: VIDEO_BYTES.byteLength,
      creditsCharged: 2520,
      model: KLING_V3_4K_MODEL,
      aspectRatio: "9:16",
      duration: "5s",
      durationSeconds: 5,
      resolution: "4k",
      generateAudio: true,
      sourceUrl: KLING_VIDEO_URL,
      requestId: "kling-video-request",
    });
    expect(observedBody).toMatchObject({
      prompt: "a vertical concert stage reveal",
      aspect_ratio: "9:16",
      duration: "5",
      generate_audio: true,
      negative_prompt: "low quality",
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
      idempotencyKey: builtInGenerationUsageIdempotencyKey({
        generationId,
        scope: "video",
        category: "output_video_seconds.audio.4k",
      }),
      category: "output_video_seconds.audio.4k",
      quantity: 5,
      creditsCharged: 2520,
      status: "processed",
      billingError: null,
    });
  });

  it("generates video files with seedance 2.0", async () => {
    const fixture = await track(seedVideoFixture({ credits: 10_000 }));
    await trackPricingRow(
      upsertVideoPricingRow({
        provider: SEEDANCE_FAST_MODEL,
        category: "output_video_tokens",
        unitPrice: 1344,
        unitSize: 100_000,
      }),
    );
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
      http.post(SEEDANCE_FAST_QUEUE_URL, async ({ request }) => {
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json({
          request_id: "seedance-video-request",
          status_url: SEEDANCE_STATUS_URL,
          response_url: SEEDANCE_RESPONSE_URL,
        });
      }),
      http.get(SEEDANCE_STATUS_URL, () => {
        return HttpResponse.json({
          status: "COMPLETED",
          response_url: SEEDANCE_RESPONSE_URL,
        });
      }),
      http.get(SEEDANCE_RESPONSE_URL, () => {
        return HttpResponse.json({
          video: {
            url: SEEDANCE_VIDEO_URL,
            content_type: "video/mp4",
            file_name: "seedance-output.mp4",
            file_size: VIDEO_BYTES.byteLength,
          },
        });
      }),
      http.get(SEEDANCE_VIDEO_URL, () => {
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
        prompt: "a wide multi-shot chase scene",
        model: "seedance2.0-fast",
        duration: "8s",
        resolution: "480p",
        aspectRatio: "21:9",
        generateAudio: false,
        seed: 42,
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
        url: SEEDANCE_VIDEO_URL,
        content_type: "video/mp4",
        file_name: "seedance-output.mp4",
        file_size: VIDEO_BYTES.byteLength,
      },
    });
    await clearAllDetached();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "video/mp4",
      size: VIDEO_BYTES.byteLength,
      creditsCharged: 1080,
      model: SEEDANCE_FAST_MODEL,
      aspectRatio: "21:9",
      duration: "8s",
      durationSeconds: 8,
      resolution: "480p",
      generateAudio: false,
      sourceUrl: SEEDANCE_VIDEO_URL,
      requestId: "seedance-video-request",
    });
    expect(observedBody).toMatchObject({
      prompt: "a wide multi-shot chase scene",
      aspect_ratio: "21:9",
      duration: "8",
      resolution: "480p",
      generate_audio: false,
      seed: 42,
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
          eq(usageEvent.provider, SEEDANCE_FAST_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      idempotencyKey: builtInGenerationUsageIdempotencyKey({
        generationId,
        scope: "video",
        category: "output_video_tokens",
      }),
      category: "output_video_tokens",
      quantity: 80_352,
      creditsCharged: 1080,
      status: "processed",
      billingError: null,
    });
  });

  it("records a failed job when fal video generation fails", async () => {
    const fixture = await track(
      seedVideoFixture({ credits: 1000, withPricing: true }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(FAL_VIDEO_QUEUE_URL, () => {
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
