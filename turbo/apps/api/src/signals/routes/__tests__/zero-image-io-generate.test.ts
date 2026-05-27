import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../app-factory";
import { builtInGenerationJobs } from "@vm0/db/schema/built-in-generation-job";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runBuiltInAdmissions } from "@vm0/db/schema/run-built-in-admission";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  IMAGE_IO_MODEL,
  imagePricingKey,
} from "../../services/zero-image-io-generate.service";
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
const IMAGE_BYTES = Buffer.from("fake image bytes");
const FAL_GPT_IMAGE_1_URL =
  "https://queue.fal.run/fal-ai/gpt-image-1/text-to-image";
const FAL_GPT_IMAGE_15_URL = "https://queue.fal.run/fal-ai/gpt-image-1.5";
const FAL_GPT_IMAGE_1_MINI_URL =
  "https://queue.fal.run/fal-ai/gpt-image-1-mini";
const FAL_GPT_IMAGE_2_URL = "https://queue.fal.run/openai/gpt-image-2";
const FAL_GPT_MEDIA_URL = "https://fal.media/files/test/gpt-image-1.webp";
const FAL_GPT_15_MEDIA_URL = "https://fal.media/files/test/gpt-image-1.5.png";
const FAL_GPT_MINI_MEDIA_URL =
  "https://fal.media/files/test/gpt-image-1-mini.jpg";
const FAL_QWEN_IMAGE_URL = "https://queue.fal.run/fal-ai/qwen-image";
const FAL_MEDIA_URL = "https://fal.media/files/test/qwen.jpg";
const FAL_FLUX_REDUX_URL = "https://queue.fal.run/fal-ai/flux-pro/v1.1/redux";
const FAL_FLUX_MEDIA_URL = "https://fal.media/files/test/flux-redux.jpg";
const FAL_NANO_BANANA_2_URL = "https://queue.fal.run/fal-ai/nano-banana-2";
const FAL_NANO_BANANA_2_EDIT_URL =
  "https://queue.fal.run/fal-ai/nano-banana-2/edit";
const FAL_NANO_BANANA_2_MEDIA_URL =
  "https://fal.media/files/test/nano-banana-2.webp";
const MOCKUP_IMAGE_URL = "https://example.com/mockup.png";
const SECOND_MOCKUP_IMAGE_URL = "https://example.com/mockup-2.png";
const IMAGE_PRICING_MARKUP_MULTIPLIER = 1.2;
const FAL_FLUX_PROVIDER_CREDITS_PER_MEGAPIXEL = 40;
const FAL_FLUX_MARKED_UP_CREDITS_PER_MEGAPIXEL = Math.ceil(
  FAL_FLUX_PROVIDER_CREDITS_PER_MEGAPIXEL * IMAGE_PRICING_MARKUP_MULTIPLIER,
);
const FAL_NANO_BANANA_2_PROVIDER_CREDITS_PER_IMAGE = 80;
const FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE = Math.ceil(
  FAL_NANO_BANANA_2_PROVIDER_CREDITS_PER_IMAGE *
    IMAGE_PRICING_MARKUP_MULTIPLIER,
);
const WEB_ORIGIN = "https://www.vm0.test";
const MISSING_PRICING_IMAGE_MODEL = "gpt-image-2";
const IMAGE_PRICING_CATEGORIES = [
  "output_image.low.standard",
  "output_image.low.large",
  "output_image.medium.standard",
  "output_image.medium.large",
  "output_image.high.standard",
  "output_image.high.large",
] as const;

const tokenRequest = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: '{"user:test-user":["subscribe"]}',
  clientId: "test-user",
  nonce: "test-nonce",
  mac: "test-mac",
});

type ImagePricingCategory = (typeof IMAGE_PRICING_CATEGORIES)[number];

interface ImageFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly insertedPricingCategories: readonly ImagePricingCategory[];
}

interface PricingSnapshot {
  readonly category: ImagePricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface DeletedPricingSnapshot {
  readonly provider: string;
  readonly rows: readonly PricingSnapshot[];
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

async function orgCredits(orgId: string): Promise<number | undefined> {
  const [row] = await store
    .set(writeDb$)
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row?.credits;
}

function falQueueHandle(requestId: string): Record<string, string> {
  return {
    request_id: requestId,
    status_url: `https://queue.fal.run/test/requests/${requestId}/status`,
    response_url: `https://queue.fal.run/test/requests/${requestId}/response`,
  };
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
  type: "image",
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

function expectedCredits(
  rows: readonly (readonly [ImagePricingCategory, number])[],
  pricing: ReadonlyMap<string, PricingSnapshot>,
): number {
  return rows.reduce((total, [category, quantity]) => {
    if (quantity <= 0) {
      return total;
    }
    const row = pricing.get(imagePricingKey(IMAGE_IO_MODEL, category));
    if (!row) {
      return total;
    }
    return total + Math.ceil((quantity * row.unitPrice) / row.unitSize);
  }, 0);
}

async function ensureImagePricing(): Promise<{
  readonly pricing: ReadonlyMap<string, PricingSnapshot>;
  readonly insertedCategories: readonly ImagePricingCategory[];
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
        eq(usagePricing.kind, "image"),
        eq(usagePricing.provider, IMAGE_IO_MODEL),
        inArray(usagePricing.category, [...IMAGE_PRICING_CATEGORIES]),
      ),
    );

  const pricing = new Map<string, PricingSnapshot>();
  for (const row of rows) {
    if (isImagePricingCategory(row.category)) {
      pricing.set(imagePricingKey(IMAGE_IO_MODEL, row.category), {
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }

  const insertedCategories: ImagePricingCategory[] = [];
  const defaults: Readonly<Record<ImagePricingCategory, PricingSnapshot>> = {
    "output_image.low.standard": {
      category: "output_image.low.standard",
      unitPrice: 13,
      unitSize: 1,
    },
    "output_image.low.large": {
      category: "output_image.low.large",
      unitPrice: 19,
      unitSize: 1,
    },
    "output_image.medium.standard": {
      category: "output_image.medium.standard",
      unitPrice: 50,
      unitSize: 1,
    },
    "output_image.medium.large": {
      category: "output_image.medium.large",
      unitPrice: 76,
      unitSize: 1,
    },
    "output_image.high.standard": {
      category: "output_image.high.standard",
      unitPrice: 200,
      unitSize: 1,
    },
    "output_image.high.large": {
      category: "output_image.high.large",
      unitPrice: 300,
      unitSize: 1,
    },
  };

  for (const category of IMAGE_PRICING_CATEGORIES) {
    if (!pricing.has(imagePricingKey(IMAGE_IO_MODEL, category))) {
      const row = defaults[category];
      const inserted = await writeDb
        .insert(usagePricing)
        .values({
          kind: "image",
          provider: IMAGE_IO_MODEL,
          category,
          unitPrice: row.unitPrice,
          unitSize: row.unitSize,
        })
        .onConflictDoNothing({
          target: [
            usagePricing.kind,
            usagePricing.provider,
            usagePricing.category,
          ],
        })
        .returning({ category: usagePricing.category });
      pricing.set(imagePricingKey(IMAGE_IO_MODEL, category), row);
      if (inserted.length > 0) {
        insertedCategories.push(category);
      }
    }
  }

  return { pricing, insertedCategories };
}

async function upsertFalImagePricing(): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(usagePricing)
    .values({
      kind: "image",
      provider: "fal-ai/qwen-image",
      category: "output_megapixel",
      unitPrice: 24,
      unitSize: 1,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: 24,
        unitSize: 1,
        updatedAt: sql`now()`,
      },
    });
}

async function upsertFluxImagePricing(): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(usagePricing)
    .values({
      kind: "image",
      provider: "fal-ai/flux-pro/v1.1",
      category: "output_megapixel",
      unitPrice: FAL_FLUX_MARKED_UP_CREDITS_PER_MEGAPIXEL,
      unitSize: 1,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: FAL_FLUX_MARKED_UP_CREDITS_PER_MEGAPIXEL,
        unitSize: 1,
        updatedAt: sql`now()`,
      },
    });
}

async function upsertNanoBanana2ImagePricing(): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(usagePricing)
    .values({
      kind: "image",
      provider: "fal-ai/nano-banana-2",
      category: "output_image",
      unitPrice: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
      unitSize: 1,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
        unitSize: 1,
        updatedAt: sql`now()`,
      },
    });
}

async function upsertFalMiniImagePricing(): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(usagePricing)
    .values([
      {
        kind: "image",
        provider: "gpt-image-1-mini",
        category: "output_image.low.standard",
        unitPrice: 6,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1-mini",
        category: "output_image.low.large",
        unitPrice: 7,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1-mini",
        category: "output_image.medium.standard",
        unitPrice: 13,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1-mini",
        category: "output_image.medium.large",
        unitPrice: 18,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1-mini",
        category: "output_image.high.standard",
        unitPrice: 43,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1-mini",
        category: "output_image.high.large",
        unitPrice: 62,
        unitSize: 1,
      },
    ])
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: 1,
        updatedAt: sql`now()`,
      },
    });
}

async function upsertFalGptImage15Pricing(): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(usagePricing)
    .values([
      {
        kind: "image",
        provider: "gpt-image-1.5",
        category: "output_image.low.standard",
        unitPrice: 11,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1.5",
        category: "output_image.low.large",
        unitPrice: 16,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1.5",
        category: "output_image.medium.standard",
        unitPrice: 41,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1.5",
        category: "output_image.medium.large",
        unitPrice: 61,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1.5",
        category: "output_image.high.standard",
        unitPrice: 160,
        unitSize: 1,
      },
      {
        kind: "image",
        provider: "gpt-image-1.5",
        category: "output_image.high.large",
        unitPrice: 240,
        unitSize: 1,
      },
    ])
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: 1,
        updatedAt: sql`now()`,
      },
    });
}

function isImagePricingCategory(value: string): value is ImagePricingCategory {
  return IMAGE_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

async function deleteImagePricingRows(
  provider: string,
): Promise<DeletedPricingSnapshot> {
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
        eq(usagePricing.kind, "image"),
        eq(usagePricing.provider, provider),
        inArray(usagePricing.category, [...IMAGE_PRICING_CATEGORIES]),
      ),
    );

  await writeDb
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "image"),
        eq(usagePricing.provider, provider),
        inArray(usagePricing.category, [...IMAGE_PRICING_CATEGORIES]),
      ),
    );

  return {
    provider,
    rows: rows.filter((row): row is PricingSnapshot => {
      return isImagePricingCategory(row.category);
    }),
  };
}

async function restoreImagePricingRows(
  snapshot: DeletedPricingSnapshot,
): Promise<void> {
  if (snapshot.rows.length === 0) {
    return;
  }
  await store
    .set(writeDb$)
    .insert(usagePricing)
    .values(
      snapshot.rows.map((row) => {
        return {
          kind: "image",
          provider: snapshot.provider,
          category: row.category,
          unitPrice: row.unitPrice,
          unitSize: row.unitSize,
        };
      }),
    )
    .onConflictDoNothing({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
    });
}

async function seedImageFixture(options: {
  readonly credits?: number;
  readonly withPricing?: boolean;
}): Promise<ImageFixture> {
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
  await writeDb.insert(orgMembersMetadata).values({
    orgId,
    userId,
  });

  const pricing = options.withPricing
    ? await ensureImagePricing()
    : { insertedCategories: [] };

  return {
    orgId,
    userId,
    insertedPricingCategories: pricing.insertedCategories,
  };
}

async function deleteImageFixture(fixture: ImageFixture): Promise<void> {
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
          eq(usagePricing.kind, "image"),
          eq(usagePricing.provider, IMAGE_IO_MODEL),
          inArray(usagePricing.category, [
            ...fixture.insertedPricingCategories,
          ]),
        ),
      );
  }
}

describe("POST /api/zero/image-io/generate", () => {
  const track = createFixtureTracker<ImageFixture>(deleteImageFixture);
  const trackPricing = createFixtureTracker<DeletedPricingSnapshot>(
    restoreImagePricingRows,
  );
  let releasePendingFalResponse: (() => void) | null = null;

  beforeEach(() => {
    mockEnv("VM0_API_URL", WEB_ORIGIN);
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.ably.publish.mockReset();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  });

  afterEach(async () => {
    releasePendingFalResponse?.();
    releasePendingFalResponse = null;
    clearMockNow();
    await clearAllDetached();
  });

  it("returns 401 when not authenticated", async () => {
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when a zero token lacks file write capability", async () => {
    const token = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: randomUUID(),
      capabilities: [],
    });

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Missing required capability: file:write",
        code: "FORBIDDEN",
      },
    });
  });

  it("rejects empty prompts before provider generation", async () => {
    const fixture = await track(seedImageFixture({ withPricing: true }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledFal = false;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "   " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "prompt is required", code: "BAD_REQUEST" },
    });
    expect(calledFal).toBeFalsy();
  });

  it("rejects transparent background requests before provider generation", async () => {
    const fixture = await track(seedImageFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledFal = false;
    server.use(
      http.post(FAL_GPT_IMAGE_2_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a transparent badge",
        model: "gpt-image-2",
        background: "transparent",
        outputFormat: "webp",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "gpt-image-2 does not support transparent backgrounds",
        code: "BAD_REQUEST",
      },
    });
    expect(calledFal).toBeFalsy();
  });

  it("returns 402 when the org has no spendable credits", async () => {
    const fixture = await track(seedImageFixture({ credits: 0 }));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
  });

  it("returns 503 when image pricing is not configured", async () => {
    const fixture = await track(seedImageFixture({ credits: 1000 }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await trackPricing(deleteImagePricingRows(MISSING_PRICING_IMAGE_MODEL));
    let calledFal = false;
    server.use(
      http.post(FAL_GPT_IMAGE_2_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a cat",
        model: MISSING_PRICING_IMAGE_MODEL,
      }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Image generation pricing is not configured",
        code: "NOT_CONFIGURED",
      },
    });
    expect(calledFal).toBeFalsy();
  });

  it("limits run-scoped zero token image generations after three active built-ins", async () => {
    const fixture = await track(seedImageFixture({ withPricing: true }));
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
    await store
      .set(writeDb$)
      .insert(runBuiltInAdmissions)
      .values([
        {
          runId,
          kind: "image",
          status: "active",
          expiresAt: new Date(now() + 60_000),
        },
        {
          runId,
          kind: "video",
          status: "active",
          expiresAt: new Date(now() + 60_000),
        },
        {
          runId,
          kind: "presentation",
          status: "active",
          expiresAt: new Date(now() + 60_000),
        },
      ]);

    let calledFal = false;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: "a limited run image" }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "This run has too many built-in generations in progress. Wait for one to finish and try again.",
        code: "BUILT_IN_RUN_CONCURRENCY_LIMIT",
      },
    });
    expect(calledFal).toBeFalsy();
  });

  it("generates image files for run-scoped zero tokens", async () => {
    const fixture = await track(seedImageFixture({ withPricing: true }));
    const { pricing } = await ensureImagePricing();
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
    const creditsCharged = expectedCredits(
      [["output_image.medium.standard", 1]],
      pricing,
    );
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json(falQueueHandle("gpt-image-1-request"));
      }),
      http.get(FAL_GPT_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/webp" },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a small robot painting a sunflower",
        size: "1024x1024",
        quality: "auto",
        background: "opaque",
        outputFormat: "webp",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_GPT_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/webp",
        },
      ],
      prompt: "A small robot paints a sunflower.",
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
        type: "image",
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
      type: "image",
      status: "completed",
    });
    const body = readGenerationResult(statusBody);
    expect(body).toMatchObject({
      contentType: "image/webp",
      size: IMAGE_BYTES.byteLength,
      creditsCharged,
      model: IMAGE_IO_MODEL,
      provider: "fal",
      imageSize: "1024x1024",
      quality: "auto",
      background: "opaque",
      outputFormat: "webp",
      moderation: "auto",
      revisedPrompt: "A small robot paints a sunflower.",
      sourceUrl: FAL_GPT_MEDIA_URL,
    });
    expect(body).not.toHaveProperty("usage");
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a small robot painting a sunflower",
      image_size: "1024x1024",
      num_images: 1,
      quality: "auto",
      background: "opaque",
      output_format: "webp",
      openai_api_key: "test-openai-key",
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
      throw new Error("Expected image response id, filename, and url");
    }
    const fileId = String(body.id);
    const filename = String(body.filename);
    const url = String(body.url);
    expect(filename).toBe(`image-${fileId.slice(0, 8)}.webp`);
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
    expect(putInput.ContentType).toBe("image/webp");
    const putBody = putInput.Body;
    expect(Buffer.isBuffer(putBody)).toBeTruthy();
    if (!Buffer.isBuffer(putBody)) {
      throw new Error("Expected S3 put body to be a Buffer");
    }
    expect(putBody).toStrictEqual(IMAGE_BYTES);

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
      contentType: "image/webp",
      sizeBytes: IMAGE_BYTES.byteLength,
      url,
    });
    expect(uploadRows[0]?.metadata).toMatchObject({
      generatedBy: "zero-official-image",
      model: IMAGE_IO_MODEL,
      imageSize: "1024x1024",
      quality: "auto",
      background: "opaque",
      outputFormat: "webp",
      moderation: "auto",
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
          eq(usageEvent.kind, "image"),
          eq(usageEvent.provider, IMAGE_IO_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId,
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId,
            scope: "image",
            category: "output_image.medium.standard",
          }),
          category: "output_image.medium.standard",
          quantity: 1,
          status: "processed",
          billingError: null,
        }),
      ]),
    );
    const totalCredits = usageRows.reduce((total, row) => {
      return total + (row.creditsCharged ?? 0);
    }, 0);
    expect(totalCredits).toBe(creditsCharged);
    await expect(orgCredits(fixture.orgId)).resolves.toBe(
      10_000 - creditsCharged,
    );
  });

  it("does not complete a job after the status route times it out", async () => {
    const fixture = await track(
      seedImageFixture({ credits: 1000, withPricing: true }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let markFalStarted = (): void => {};
    const falStarted = new Promise<void>((resolve) => {
      markFalStarted = resolve;
    });
    let observedRequestUrl: string | null = null;

    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        observedRequestUrl = request.url;
        await request.json();
        markFalStarted();
        return HttpResponse.json(falQueueHandle("late-gpt-image-1-request"));
      }),
      http.get(FAL_GPT_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/webp" },
        });
      }),
    );

    const staleTime = new Date("2026-05-15T12:00:00.000Z");
    const timeoutTime = new Date(staleTime.getTime() + 16 * 60 * 1000);
    mockNow(staleTime);

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a late image" }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await falStarted;

    mockNow(timeoutTime);
    const timeoutResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(timeoutResponse.status).toBe(200);
    await expect(timeoutResponse.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Generation timed out. Please try again.",
        code: "GENERATION_TIMEOUT",
      },
    });

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_GPT_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/webp",
        },
      ],
      prompt: "A late robot paints a sunflower.",
    });
    await clearAllDetached();
    releasePendingFalResponse = null;

    const finalStatusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(finalStatusResponse.status).toBe(200);
    await expect(finalStatusResponse.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Generation timed out. Please try again.",
        code: "GENERATION_TIMEOUT",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "image"),
          eq(usageEvent.provider, IMAGE_IO_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(0);
  });

  it("generates fal image files and settles megapixel usage asynchronously", async () => {
    const fixture = await track(seedImageFixture({ credits: 1000 }));
    await upsertFalImagePricing();
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
      http.post(FAL_QWEN_IMAGE_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
        return HttpResponse.json(falQueueHandle("qwen-image-request"));
      }),
      http.get(FAL_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "a precise product render",
        model: "qwen-image",
        size: "1536x1024",
        outputFormat: "jpeg",
        seed: 99,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_MEDIA_URL,
          width: 1536,
          height: 1024,
          content_type: "image/jpeg",
        },
      ],
      prompt: "A precise product render.",
      seed: 99,
    });
    await clearAllDetached();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/jpeg",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 48,
      model: "fal-ai/qwen-image",
      provider: "fal",
      imageSize: "1536x1024",
      quality: "model-default",
      background: "auto",
      outputFormat: "jpeg",
      billingCategory: "output_megapixel",
      billingQuantity: 2,
      sourceUrl: FAL_MEDIA_URL,
      seed: 99,
    });
    expect(body).not.toHaveProperty("usage");
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a precise product render",
      image_size: { width: 1536, height: 1024 },
      num_images: 1,
      output_format: "jpeg",
      seed: 99,
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body
      )
    ) {
      throw new Error("Expected image response id and filename");
    }
    const fileId = String(body.id);
    const filename = String(body.filename);
    const putInput = commandInput(context.mocks.s3.send.mock.calls[0]?.[0]);
    expect(putInput.Key).toBe(
      `artifacts/${fixture.userId}/${fileId}/${filename}`,
    );
    expect(putInput.ContentType).toBe("image/jpeg");

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "image"),
          eq(usageEvent.provider, "fal-ai/qwen-image"),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      runId,
      idempotencyKey: builtInGenerationUsageIdempotencyKey({
        generationId,
        scope: "image",
        category: "output_megapixel",
      }),
      category: "output_megapixel",
      quantity: 2,
      status: "processed",
      billingError: null,
      creditsCharged: 48,
    });
    await expect(orgCredits(fixture.orgId)).resolves.toBe(952);
  });

  it("generates image-to-image through fal with 20 percent markup pricing", async () => {
    const fixture = await track(seedImageFixture({ credits: 1000 }));
    await upsertFluxImagePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_FLUX_REDUX_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("flux-redux-request"));
      }),
      http.get(FAL_FLUX_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "turn this wireframe into a polished product mockup",
        model: "flux-pro-1.1",
        imageUrl: MOCKUP_IMAGE_URL,
        outputFormat: "jpeg",
        seed: 42,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_FLUX_MEDIA_URL,
          width: 1536,
          height: 1024,
          content_type: "image/jpeg",
        },
      ],
      prompt: "A polished product mockup.",
      seed: 42,
    });
    await clearAllDetached();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/jpeg",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 96,
      model: "fal-ai/flux-pro/v1.1",
      provider: "fal",
      imageSize: "1536x1024",
      outputFormat: "jpeg",
      billingCategory: "output_megapixel",
      billingQuantity: 2,
      sourceUrl: FAL_FLUX_MEDIA_URL,
      sourceImageUrls: [MOCKUP_IMAGE_URL],
      seed: 42,
    });
    expect(body).not.toHaveProperty("imagePromptStrength");
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "turn this wireframe into a polished product mockup",
      image_size: "landscape_4_3",
      num_images: 1,
      output_format: "jpeg",
      seed: 42,
      safety_tolerance: "4",
      enhance_prompt: false,
      image_url: MOCKUP_IMAGE_URL,
    });
    expect(observedBody).not.toHaveProperty("image_prompt_strength");

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "image"),
          eq(usageEvent.provider, "fal-ai/flux-pro/v1.1"),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      idempotencyKey: builtInGenerationUsageIdempotencyKey({
        generationId,
        scope: "image",
        category: "output_megapixel",
      }),
      category: "output_megapixel",
      quantity: 2,
      status: "processed",
      billingError: null,
      creditsCharged: 96,
    });
  });

  it("generates Nano Banana 2 images through fal with 20 percent markup pricing", async () => {
    const fixture = await track(seedImageFixture({ credits: 1000 }));
    await upsertNanoBanana2ImagePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_NANO_BANANA_2_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("nano-banana-2-request"));
      }),
      http.get(FAL_NANO_BANANA_2_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/webp" },
        });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a launch poster with crisp product typography",
        model: "nano-banana-2",
        size: "1024x1024",
        outputFormat: "webp",
        seed: 123,
        safetyTolerance: "5",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_NANO_BANANA_2_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/webp",
        },
      ],
      description: "A launch poster with crisp product typography.",
      seed: 123,
    });
    await clearAllDetached();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/webp",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
      model: "fal-ai/nano-banana-2",
      provider: "fal",
      imageSize: "1024x1024",
      quality: "model-default",
      background: "auto",
      outputFormat: "webp",
      billingCategory: "output_image",
      billingQuantity: 1,
      sourceUrl: FAL_NANO_BANANA_2_MEDIA_URL,
      seed: 123,
    });
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a launch poster with crisp product typography",
      aspect_ratio: "1:1",
      num_images: 1,
      output_format: "webp",
      resolution: "1K",
      seed: 123,
      safety_tolerance: "5",
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "image"),
          eq(usageEvent.provider, "fal-ai/nano-banana-2"),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      idempotencyKey: builtInGenerationUsageIdempotencyKey({
        generationId,
        scope: "image",
        category: "output_image",
      }),
      category: "output_image",
      quantity: 1,
      status: "processed",
      billingError: null,
      creditsCharged: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
    });
  });

  it("edits images with Nano Banana 2 through fal", async () => {
    const fixture = await track(seedImageFixture({ credits: 1000 }));
    await upsertNanoBanana2ImagePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_NANO_BANANA_2_EDIT_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("nano-banana-2-edit-request"));
      }),
      http.get(FAL_NANO_BANANA_2_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const sourceImageUrls = [MOCKUP_IMAGE_URL, SECOND_MOCKUP_IMAGE_URL];
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "combine these references into a polished product campaign",
        model: "nano-banana-2",
        imageUrls: sourceImageUrls,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_NANO_BANANA_2_MEDIA_URL,
          width: 1536,
          height: 1024,
          content_type: "image/png",
        },
      ],
      description: "A polished product campaign.",
    });
    await clearAllDetached();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      creditsCharged: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
      model: "fal-ai/nano-banana-2",
      provider: "fal",
      imageSize: "1536x1024",
      quality: "model-default",
      background: "auto",
      outputFormat: "png",
      billingCategory: "output_image",
      billingQuantity: 1,
      sourceUrl: FAL_NANO_BANANA_2_MEDIA_URL,
      sourceImageUrls,
    });
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "combine these references into a polished product campaign",
      aspect_ratio: "auto",
      num_images: 1,
      output_format: "png",
      resolution: "1K",
      safety_tolerance: "4",
      image_urls: sourceImageUrls,
    });
  });

  it("generates GPT Image 1.5 through fal without returned usage", async () => {
    const fixture = await track(seedImageFixture({ credits: 1000 }));
    await upsertFalGptImage15Pricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_GPT_IMAGE_15_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("gpt-image-15-request"));
      }),
      http.get(FAL_GPT_15_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a precise medical infographic",
        model: "gpt-image-1.5",
        size: "1024x1024",
        quality: "low",
        outputFormat: "png",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_GPT_15_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
      prompt: "A precise medical infographic.",
    });
    await clearAllDetached();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 11,
      model: "gpt-image-1.5",
      provider: "fal",
      imageSize: "1024x1024",
      quality: "low",
      background: "auto",
      outputFormat: "png",
      billingCategory: "output_image.low.standard",
      billingQuantity: 1,
      sourceUrl: FAL_GPT_15_MEDIA_URL,
    });
    expect(body).not.toHaveProperty("usage");
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a precise medical infographic",
      image_size: "1024x1024",
      num_images: 1,
      quality: "low",
      background: "auto",
      output_format: "png",
      openai_api_key: "test-openai-key",
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "image"),
          eq(usageEvent.provider, "gpt-image-1.5"),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      idempotencyKey: builtInGenerationUsageIdempotencyKey({
        generationId,
        scope: "image",
        category: "output_image.low.standard",
      }),
      category: "output_image.low.standard",
      quantity: 1,
      status: "processed",
      billingError: null,
      creditsCharged: 11,
    });
  });

  it("generates GPT Image 1 mini through fal without BYOK usage", async () => {
    const fixture = await track(seedImageFixture({ credits: 1000 }));
    await upsertFalMiniImagePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_MINI_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("gpt-image-mini-request"));
      }),
      http.get(FAL_GPT_MINI_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a compact technical diagram",
        model: "gpt-image-1-mini",
        size: "1024x1536",
        quality: "medium",
        outputFormat: "jpeg",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await postFalWebhook(app, observedRequestUrl, {
      images: [
        {
          url: FAL_GPT_MINI_MEDIA_URL,
          width: 1024,
          height: 1536,
          content_type: "image/jpeg",
        },
      ],
      prompt: "A compact technical diagram.",
    });
    await clearAllDetached();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/jpeg",
      size: IMAGE_BYTES.byteLength,
      creditsCharged: 18,
      model: "gpt-image-1-mini",
      provider: "fal",
      imageSize: "1024x1536",
      quality: "medium",
      background: "auto",
      outputFormat: "jpeg",
      billingCategory: "output_image.medium.large",
      billingQuantity: 1,
      sourceUrl: FAL_GPT_MINI_MEDIA_URL,
    });
    expect(body).not.toHaveProperty("usage");
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toMatchObject({
      prompt: "a compact technical diagram",
      image_size: "1024x1536",
      num_images: 1,
      quality: "medium",
      background: "auto",
      output_format: "jpeg",
    });
    expect(observedBody).not.toHaveProperty("openai_api_key");

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "image"),
          eq(usageEvent.provider, "gpt-image-1-mini"),
        ),
      );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      idempotencyKey: builtInGenerationUsageIdempotencyKey({
        generationId,
        scope: "image",
        category: "output_image.medium.large",
      }),
      category: "output_image.medium.large",
      quantity: 1,
      status: "processed",
      billingError: null,
      creditsCharged: 18,
    });
  });

  it("records a failed job when fal image generation fails", async () => {
    const fixture = await track(
      seedImageFixture({ credits: 1000, withPricing: true }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Image generation failed",
        code: "FAL_IMAGE_REQUEST_FAILED",
      },
    });
    const jobRows = await store
      .set(writeDb$)
      .select()
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.orgId, fixture.orgId));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({
      type: "image",
      status: "failed",
      error: {
        message: "Image generation failed",
        code: "FAL_IMAGE_REQUEST_FAILED",
      },
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${jobRows[0]?.id}`,
      expect.objectContaining({
        generationId: jobRows[0]?.id,
        type: "image",
        status: "failed",
      }),
    );
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(eq(usageEvent.orgId, fixture.orgId));
    expect(usageRows).toHaveLength(0);
    await expect(orgCredits(fixture.orgId)).resolves.toBe(1000);
  });
});
