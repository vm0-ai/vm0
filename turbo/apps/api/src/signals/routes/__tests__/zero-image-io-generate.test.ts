import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now, nowDate } from "../../external/time";
import { createDeferredPromise } from "../../utils";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { zeroBillingStatusRoutes } from "../zero-billing-status";
import { zeroBuiltInGenerationRoutes } from "../zero-built-in-generation";
import { zeroImageIoGenerateRoutes } from "../zero-image-io-generate";
import { zeroUsageRecordRoutes } from "../zero-usage-record";
import {
  deleteUsagePricingRows,
  ensureUsagePricingRow,
  seedOrgMetadata,
  seedUsagePricingRows,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { seedCompose$, seedRun$ } from "./helpers/zero-usage-insight";
import {
  generatedStripeCustomerId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const TEST_BUCKET = "test-user-artifacts";
const IMAGE_BYTES = Buffer.from("fake image bytes");
const IMAGE_IO_MODEL = "gpt-image-1";
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
const FAL_BIREFNET_URL = "https://queue.fal.run/fal-ai/birefnet/v2";
const FAL_BIREFNET_MEDIA_URL = "https://fal.media/files/test/birefnet.png";
const FAL_CLARITY_UPSCALER_URL =
  "https://queue.fal.run/fal-ai/clarity-upscaler";
const FAL_CLARITY_UPSCALER_MEDIA_URL =
  "https://fal.media/files/test/clarity-upscaler.png";
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

function imagePricingKey(
  model: string,
  category: ImagePricingCategory,
): string {
  return `${model}:${category}`;
}

// Recovers the generation ID for a synchronously failed submission from its
// realtime failure publish (`built-in-generation:{id}`), the product-visible
// signal a client would use.
function readPublishedGenerationId(
  publishCalls: readonly (readonly unknown[])[],
): string {
  for (const call of publishCalls) {
    const eventName = call[0];
    if (
      typeof eventName === "string" &&
      eventName.startsWith("built-in-generation:")
    ) {
      return eventName.slice("built-in-generation:".length);
    }
  }
  throw new Error("Expected a built-in-generation publish");
}

interface ImageFixture {
  readonly orgId: string;
  readonly userId: string;
}

type PricingSnapshot = UsagePricingRow;
type DeletedPricingSnapshot = readonly UsagePricingRow[];

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createImageIoTestApp() {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...zeroBuiltInGenerationRoutes,
      ...zeroImageIoGenerateRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...zeroBillingStatusRoutes,
      ...zeroUsageRecordRoutes,
    ],
  });
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

// Reads the org credit balance through the product billing surface so charge
// assertions stay on externally observable state.
async function orgCredits(fixture: ImageFixture): Promise<number> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const app = createImageIoTestApp();
  const response = await app.request("/api/zero/billing/status", {
    headers: authHeaders(),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("credits" in body) ||
    typeof body.credits !== "number"
  ) {
    throw new Error("Expected billing status credits");
  }
  return body.credits;
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
  app: ReturnType<typeof createImageIoTestApp>,
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
}> {
  const defaults: Readonly<Record<ImagePricingCategory, PricingSnapshot>> = {
    "output_image.low.standard": {
      kind: "image",
      provider: IMAGE_IO_MODEL,
      category: "output_image.low.standard",
      unitPrice: 13,
      unitSize: 1,
    },
    "output_image.low.large": {
      kind: "image",
      provider: IMAGE_IO_MODEL,
      category: "output_image.low.large",
      unitPrice: 19,
      unitSize: 1,
    },
    "output_image.medium.standard": {
      kind: "image",
      provider: IMAGE_IO_MODEL,
      category: "output_image.medium.standard",
      unitPrice: 50,
      unitSize: 1,
    },
    "output_image.medium.large": {
      kind: "image",
      provider: IMAGE_IO_MODEL,
      category: "output_image.medium.large",
      unitPrice: 76,
      unitSize: 1,
    },
    "output_image.high.standard": {
      kind: "image",
      provider: IMAGE_IO_MODEL,
      category: "output_image.high.standard",
      unitPrice: 200,
      unitSize: 1,
    },
    "output_image.high.large": {
      kind: "image",
      provider: IMAGE_IO_MODEL,
      category: "output_image.high.large",
      unitPrice: 300,
      unitSize: 1,
    },
  };

  const pricing = new Map<string, PricingSnapshot>();
  for (const category of IMAGE_PRICING_CATEGORIES) {
    const result = await ensureUsagePricingRow(defaults[category]);
    pricing.set(imagePricingKey(IMAGE_IO_MODEL, category), result.pricing);
  }

  return { pricing };
}

async function upsertFalImagePricing(): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "image",
      provider: "fal-ai/qwen-image",
      category: "output_megapixel",
      unitPrice: 24,
      unitSize: 1,
    },
  ]);
}

async function upsertFluxImagePricing(): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "image",
      provider: "fal-ai/flux-pro/v1.1",
      category: "output_megapixel",
      unitPrice: FAL_FLUX_MARKED_UP_CREDITS_PER_MEGAPIXEL,
      unitSize: 1,
    },
  ]);
}

async function upsertNanoBanana2ImagePricing(): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "image",
      provider: "fal-ai/nano-banana-2",
      category: "output_image",
      unitPrice: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
      unitSize: 1,
    },
  ]);
}

async function upsertBirefnetImagePricing(): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "image",
      provider: "fal-ai/birefnet/v2",
      category: "output_image",
      unitPrice: 0,
      unitSize: 1,
    },
  ]);
}

async function upsertClarityUpscalerImagePricing(): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "image",
      provider: "fal-ai/clarity-upscaler",
      category: "output_megapixel",
      unitPrice: 30,
      unitSize: 1,
    },
  ]);
}

async function upsertFalMiniImagePricing(): Promise<void> {
  await seedUsagePricingRows([
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
  ]);
}

async function upsertFalGptImage15Pricing(): Promise<void> {
  await seedUsagePricingRows([
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
  ]);
}

async function deleteImagePricingRows(
  provider: string,
): Promise<DeletedPricingSnapshot> {
  return await deleteUsagePricingRows({
    kind: "image",
    provider,
    categories: [...IMAGE_PRICING_CATEGORIES],
  });
}

async function restoreImagePricingRows(
  snapshot: DeletedPricingSnapshot,
): Promise<void> {
  await seedUsagePricingRows(snapshot);
}

// Isolation comes from random org/user IDs; no teardown is needed.
async function seedImageFixture(options: {
  readonly credits?: number;
  readonly withPricing?: boolean;
}): Promise<ImageFixture> {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };

  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: "free",
    credits: options.credits ?? 10_000,
  });
  await store.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
    context.signal,
  );

  if (options.withPricing) {
    await ensureImagePricing();
  }

  return fixture;
}

describe("POST /api/zero/image-io/generate", () => {
  const trackPricing = createFixtureTracker<DeletedPricingSnapshot>(
    restoreImagePricingRows,
  );
  let releasePendingFalResponse: (() => void) | null = null;

  beforeEach(() => {
    mockEnv("VM0_API_BACKEND_URL", WEB_ORIGIN);
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
    await flushWaitUntilForTest();
  });

  it("returns 401 when not authenticated", async () => {
    const app = createImageIoTestApp();
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

    const app = createImageIoTestApp();
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
    const fixture = await seedImageFixture({ withPricing: true });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledFal = false;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp();
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
    const fixture = await seedImageFixture({});
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledFal = false;
    server.use(
      http.post(FAL_GPT_IMAGE_2_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp();
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
    const fixture = await seedImageFixture({ credits: 0 });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const app = createImageIoTestApp();
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

  it("admits image generation when allowance remains", async () => {
    const fixture = await seedImageFixture({ credits: 0, withPricing: true });
    const effectiveAt = nowDate();
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      customerId: generatedStripeCustomerId(),
      subscriptionId: `sub_image_allowance_${randomUUID()}`,
      effectiveAt,
      expiresAt: new Date(effectiveAt.getTime() + 365 * 24 * 60 * 60 * 1000),
      shortWindowSeconds: 5 * 60 * 60,
      shortWindowUnits: 100,
      weeklyWindowSeconds: 7 * 24 * 60 * 60,
      weeklyWindowUnits: 200,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        return HttpResponse.json(falQueueHandle("allowance-image-request"));
      }),
    );

    const response = await createImageIoTestApp().request(
      "/api/zero/image-io/generate",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt: "a cat covered by allowance" }),
      },
    );

    expect(response.status).toBe(202);
  });

  it("returns 503 when image pricing is not configured", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await trackPricing(deleteImagePricingRows(MISSING_PRICING_IMAGE_MODEL));
    let calledFal = false;
    server.use(
      http.post(FAL_GPT_IMAGE_2_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp();
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
    const fixture = await seedImageFixture({ withPricing: true });
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
    // Occupy all three in-flight slots through the product flow: submit
    // generations that stay pending because the provider webhook never fires.
    let falCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        falCalls += 1;
        return HttpResponse.json(falQueueHandle(`pending-image-${falCalls}`));
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp();
    for (let submission = 0; submission < 3; submission++) {
      const submitted = await app.request("/api/zero/image-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: `a pending run image ${submission}` }),
      });
      expect(submitted.status).toBe(202);
    }
    expect(falCalls).toBe(3);

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
    expect(falCalls).toBe(3);
  });

  it("generates image files for run-scoped zero tokens", async () => {
    const fixture = await seedImageFixture({ withPricing: true });
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
    const app = createImageIoTestApp();
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
    await flushWaitUntilForTest();
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

    // The charge is asserted through product surfaces: the settled usage shows
    // up in the user's usage record with image/provider attribution, and the
    // org balance drops by exactly the credits charged (a single settlement).
    await expect(orgCredits(fixture)).resolves.toBe(10_000 - creditsCharged);

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const usageResponse = await app.request("/api/zero/usage/record", {
      headers: authHeaders(),
    });
    expect(usageResponse.status).toBe(200);
    await expect(usageResponse.json()).resolves.toMatchObject({
      totalCredits: creditsCharged,
      rows: [
        expect.objectContaining({
          source: "chat",
          credits: creditsCharged,
          breakdown: [
            {
              kind: "image",
              credits: creditsCharged,
              providers: [
                {
                  provider: IMAGE_IO_MODEL,
                  credits: creditsCharged,
                  usageKinds: [{ kind: "image", credits: creditsCharged }],
                },
              ],
            },
          ],
        }),
      ],
    });
  });

  it("does not complete a job after the status route times it out", async () => {
    const fixture = await seedImageFixture({
      credits: 1000,
      withPricing: true,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const falStarted = createDeferredPromise<void>(context.signal);
    const markFalStarted = (): void => {
      if (!falStarted.settled()) {
        falStarted.resolve(undefined);
      }
    };
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

    const app = createImageIoTestApp();
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
    await flushWaitUntilForTest();
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

    // No usage settles for a timed-out job: the org balance is unchanged.
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("generates fal image files and settles megapixel usage asynchronously", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
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
    const app = createImageIoTestApp();
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
    await flushWaitUntilForTest();

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

    // The megapixel category/quantity are asserted in the result body above;
    // the single settled charge is observable as the exact balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(952);
  });

  it("generates image-to-image through fal with 20 percent markup pricing", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
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

    const app = createImageIoTestApp();
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
    await flushWaitUntilForTest();

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

    // The marked-up charge (2 megapixels at 48/megapixel) is asserted through
    // the result body above and the exact org balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(1000 - 96);
  });

  it("generates Nano Banana 2 images through fal with 20 percent markup pricing", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
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

    const app = createImageIoTestApp();
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
    await flushWaitUntilForTest();

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

    // The per-image marked-up charge is asserted through the result body
    // above and the exact org balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 - FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
    );
  });

  it("edits images with Nano Banana 2 through fal", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
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
    const app = createImageIoTestApp();
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
    await flushWaitUntilForTest();

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
    await expect(orgCredits(fixture)).resolves.toBe(
      1000 - FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
    );
  });

  it("removes backgrounds with birefnet through fal without a prompt", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    await upsertBirefnetImagePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_BIREFNET_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("birefnet-request"));
      }),
      http.get(FAL_BIREFNET_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp();
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "birefnet",
        sourceImageUrls: [MOCKUP_IMAGE_URL],
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
          url: FAL_BIREFNET_MEDIA_URL,
          width: 1024,
          height: 1024,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    expect(observedRequestUrl).not.toBeNull();
    expect(new URL(observedRequestUrl ?? "").pathname).toBe(
      "/fal-ai/birefnet/v2",
    );

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      model: "fal-ai/birefnet/v2",
      provider: "fal",
      outputFormat: "png",
      billingCategory: "output_image",
      billingQuantity: 1,
      sourceUrl: FAL_BIREFNET_MEDIA_URL,
      sourceImageUrls: [MOCKUP_IMAGE_URL],
    });
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({ image_url: MOCKUP_IMAGE_URL });
    expect(observedBody).not.toHaveProperty("prompt");
  });

  it("upscales images with clarity-upscaler through fal without a prompt", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    await upsertClarityUpscalerImagePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_CLARITY_UPSCALER_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(falQueueHandle("clarity-upscaler-request"));
      }),
      http.get(FAL_CLARITY_UPSCALER_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp();
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "clarity-upscaler",
        imageUrl: MOCKUP_IMAGE_URL,
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
          url: FAL_CLARITY_UPSCALER_MEDIA_URL,
          width: 2048,
          height: 2048,
          content_type: "image/png",
        },
      ],
    });
    await flushWaitUntilForTest();

    expect(observedRequestUrl).not.toBeNull();
    expect(new URL(observedRequestUrl ?? "").pathname).toBe(
      "/fal-ai/clarity-upscaler",
    );

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      model: "fal-ai/clarity-upscaler",
      provider: "fal",
      imageSize: "2048x2048",
      outputFormat: "png",
      billingCategory: "output_megapixel",
      billingQuantity: 5,
      sourceUrl: FAL_CLARITY_UPSCALER_MEDIA_URL,
      sourceImageUrls: [MOCKUP_IMAGE_URL],
    });
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({ image_url: MOCKUP_IMAGE_URL });
    expect(observedBody).not.toHaveProperty("prompt");
  });

  it("rejects promptless models without a source image", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    await upsertBirefnetImagePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledFal = false;
    server.use(
      http.post(FAL_BIREFNET_URL, () => {
        calledFal = true;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp();
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ model: "birefnet" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "birefnet requires imageUrl",
        code: "BAD_REQUEST",
      },
    });
    expect(calledFal).toBeFalsy();
  });

  it("generates GPT Image 1.5 through fal without returned usage", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
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

    const app = createImageIoTestApp();
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
    await flushWaitUntilForTest();

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

    // The low/standard-tier charge is asserted through the result body above
    // and the exact org balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(1000 - 11);
  });

  it("generates GPT Image 1 mini through fal without BYOK usage", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
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

    const app = createImageIoTestApp();
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
    await flushWaitUntilForTest();

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

    // The medium/large-tier charge is asserted through the result body above
    // and the exact org balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(1000 - 18);
  });

  it("records a failed job when fal image generation fails", async () => {
    const fixture = await seedImageFixture({
      credits: 1000,
      withPricing: true,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const app = createImageIoTestApp();
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
    // The failed job is observed through its realtime failure event and the
    // product status route rather than by reading job rows.
    const generationId = readPublishedGenerationId(
      context.mocks.ably.publish.mock.calls,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "image",
        status: "failed",
      }),
    );
    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      generationId,
      type: "image",
      status: "failed",
      error: {
        message: "Image generation failed",
        code: "FAL_IMAGE_REQUEST_FAILED",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    // No usage settles for a failed submission: the org balance is unchanged.
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });
});
