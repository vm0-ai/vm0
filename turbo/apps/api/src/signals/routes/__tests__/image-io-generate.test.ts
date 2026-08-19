import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  PutObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createDeferredPromise } from "../../utils";
import { webhooksBuiltInGenerationRoutes } from "../webhooks-built-in-generations";
import { billingStatusRoutes } from "../billing-status";
import { builtInGenerationRoutes } from "../built-in-generation";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { usageRecordRoutes } from "../usage-record";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingKey,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { seedCompose$, seedRun$ } from "./helpers/usage-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  generatedStripeCustomerId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { setRunImageModelFixture } from "../../../test-fixtures/run-image-model";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const TEST_BUCKET = "test-user-artifacts";
const IMAGE_BYTES = Buffer.from("fake image bytes");
const IMAGE_IO_MODEL = "gpt-image-1";
const FAL_GPT_IMAGE_1_URL =
  "https://queue.fal.run/fal-ai/gpt-image-1/text-to-image";
const FAL_GPT_IMAGE_2_URL = "https://queue.fal.run/openai/gpt-image-2";
const BYTEPLUS_IMAGE_GENERATIONS_URL =
  "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";
const BYTEPLUS_SEEDREAM_5_LITE_MEDIA_URL =
  "https://ark-content.byteplus.example/files/seedream-5-lite.png";
const BYTEPLUS_SEEDREAM_5_PRO_LOW_MEDIA_URL =
  "https://ark-content.byteplus.example/files/seedream-5-pro-low.jpg";
const BYTEPLUS_SEEDREAM_5_PRO_HIGH_MEDIA_URL =
  "https://ark-content.byteplus.example/files/seedream-5-pro-high.jpg";
const FAL_GPT_MEDIA_URL = "https://fal.media/files/test/gpt-image-1.webp";
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
const THIRD_MOCKUP_IMAGE_URL = "https://example.com/mockup-3.png";
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

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createImageIoTestApp(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...builtInGenerationRoutes,
      ...imageIoGenerateRoutes,
      ...webhooksBuiltInGenerationRoutes,
      ...billingStatusRoutes,
      ...usageRecordRoutes,
    ],
    usagePricingResolution,
  });
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function putObjectInput(): PutObjectCommandInput {
  const command = context.mocks.s3.send.mock.calls
    .map(([candidate]) => {
      return candidate;
    })
    .find((candidate): candidate is PutObjectCommand => {
      return candidate instanceof PutObjectCommand;
    });
  if (!command) {
    throw new Error("Expected generated image to be uploaded to S3");
  }
  return command.input;
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

const GPT_IMAGE_1_PRICING = [
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.low.standard",
    unitPrice: 13,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.low.large",
    unitPrice: 19,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.medium.standard",
    unitPrice: 50,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.medium.large",
    unitPrice: 76,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.high.standard",
    unitPrice: 200,
    unitSize: 1,
  },
  {
    kind: "image",
    provider: IMAGE_IO_MODEL,
    category: "output_image.high.large",
    unitPrice: 300,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const QWEN_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/qwen-image",
    category: "output_megapixel",
    unitPrice: 24,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const SEEDREAM_5_LITE_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "seedream-5-0-lite-260128",
    category: "provider_cost_usd_micros",
    unitPrice: 1250,
    unitSize: 1_000_000,
  },
] satisfies readonly UsagePricingRow[];

const SEEDREAM_5_PRO_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "dola-seedream-5-0-pro-260628",
    category: "provider_cost_usd_micros",
    unitPrice: 1250,
    unitSize: 1_000_000,
  },
] satisfies readonly UsagePricingRow[];

const FLUX_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/flux-pro/v1.1",
    category: "output_megapixel",
    unitPrice: FAL_FLUX_MARKED_UP_CREDITS_PER_MEGAPIXEL,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const NANO_BANANA_2_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/nano-banana-2",
    category: "output_image",
    unitPrice: FAL_NANO_BANANA_2_MARKED_UP_CREDITS_PER_IMAGE,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const BIREFNET_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/birefnet/v2",
    category: "output_image",
    unitPrice: 0,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const CLARITY_UPSCALER_IMAGE_PRICING = [
  {
    kind: "image",
    provider: "fal-ai/clarity-upscaler",
    category: "output_megapixel",
    unitPrice: 30,
    unitSize: 1,
  },
] satisfies readonly UsagePricingRow[];

const MISSING_GPT_IMAGE_2_PRICING: readonly UsagePricingKey[] =
  IMAGE_PRICING_CATEGORIES.map((category) => {
    return {
      kind: "image",
      provider: MISSING_PRICING_IMAGE_MODEL,
      category,
    };
  });

async function createScopedImagePricing(options: {
  readonly configured?: readonly UsagePricingRow[];
  readonly missing?: readonly UsagePricingKey[];
}): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture(options);
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

// Isolation comes from random org/user IDs; no teardown is needed.
async function seedImageFixture(options: {
  readonly credits?: number;
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

  return fixture;
}

async function seedImageRun(
  fixture: ImageFixture,
  options: {
    readonly imageModelSelectionEnabled: boolean;
    readonly selectedImageModel: string | null;
  },
): Promise<{ readonly runId: string }> {
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
  await setRunImageModelFixture(runId, options.selectedImageModel);
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.ImageModelSelection]: options.imageModelSelectionEnabled,
  });
  return { runId };
}

describe("POST /api/zero/image-io/generate", () => {
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
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "   " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "prompt is required", code: "BAD_REQUEST" },
    });
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(10_000);
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

  it("uses the stable run snapshot for omitted and blank models", async () => {
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: QWEN_IMAGE_PRICING,
    });
    const { runId } = await seedImageRun(fixture, {
      imageModelSelectionEnabled: true,
      selectedImageModel: "fal-ai/qwen-image",
    });

    let falCalls = 0;
    server.use(
      http.post(FAL_QWEN_IMAGE_URL, () => {
        falCalls += 1;
        return HttpResponse.json(falQueueHandle(`run-default-${falCalls}`));
      }),
    );
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp(pricingFixture.resolution);
    const prompts = ["omitted model prompt", "blank model prompt"];

    for (const [index, prompt] of prompts.entries()) {
      const response = await app.request("/api/zero/image-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt,
          ...(index === 0 ? {} : { model: "   " }),
        }),
      });
      expect(response.status).toBe(202);
    }

    expect(falCalls).toBe(2);
  });

  it("preserves a valid explicit model and rejects an invalid explicit model", async () => {
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: [...GPT_IMAGE_1_PRICING, ...QWEN_IMAGE_PRICING],
    });
    const { runId } = await seedImageRun(fixture, {
      imageModelSelectionEnabled: true,
      selectedImageModel: "fal-ai/qwen-image",
    });
    let gptCalls = 0;
    let qwenCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        gptCalls += 1;
        return HttpResponse.json(falQueueHandle("explicit-gpt-image-1"));
      }),
      http.post(FAL_QWEN_IMAGE_URL, () => {
        qwenCalls += 1;
        return HttpResponse.json(falQueueHandle("unexpected-qwen"));
      }),
    );
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp(pricingFixture.resolution);

    const explicitResponse = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "explicit model parameters use the explicit model",
        model: "gpt-image-1",
        background: "transparent",
        outputFormat: "webp",
      }),
    });
    expect(explicitResponse.status).toBe(202);
    expect(gptCalls).toBe(1);
    expect(qwenCalls).toBe(0);

    const invalidResponse = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "invalid explicit model must not fall back",
        model: "not-a-real-image-model",
      }),
    });
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: {
        message: expect.stringContaining(
          "Unsupported image model: not-a-real-image-model",
        ),
        code: "BAD_REQUEST",
      },
    });
    expect(gptCalls).toBe(1);
    expect(qwenCalls).toBe(0);
  });

  it("keeps the global default for disabled, null, old, and session paths", async () => {
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    let gptCalls = 0;
    let qwenCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        gptCalls += 1;
        return HttpResponse.json(falQueueHandle(`global-default-${gptCalls}`));
      }),
      http.post(FAL_QWEN_IMAGE_URL, () => {
        qwenCalls += 1;
        return HttpResponse.json(falQueueHandle("unexpected-run-default"));
      }),
    );
    const app = createImageIoTestApp(pricingFixture.resolution);

    const runCases = [
      {
        imageModelSelectionEnabled: false,
        selectedImageModel: "fal-ai/qwen-image",
        prompt: "disabled switch",
      },
      {
        imageModelSelectionEnabled: true,
        selectedImageModel: null,
        prompt: "null snapshot",
      },
      {
        imageModelSelectionEnabled: true,
        selectedImageModel: "fal-ai/retired-image-model",
        prompt: "old snapshot",
      },
    ] as const;
    for (const runCase of runCases) {
      const fixture = await seedImageFixture({});
      const { runId } = await seedImageRun(fixture, runCase);
      const token = zeroToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
        runId,
      });
      const response = await app.request("/api/zero/image-io/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: runCase.prompt }),
      });
      expect(response.status).toBe(202);
    }

    const sessionFixture = await seedImageFixture({});
    await updateFeatureSwitchesForUser(context, sessionFixture, {
      [FeatureSwitchKey.ImageModelSelection]: true,
    });
    mocks.clerk.session(sessionFixture.userId, sessionFixture.orgId);
    const sessionResponse = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "session request without a run" }),
    });
    expect(sessionResponse.status).toBe(202);

    expect(gptCalls).toBe(4);
    expect(qwenCalls).toBe(0);
  });

  it("returns 402 when the org has no spendable credits", async () => {
    const fixture = await seedImageFixture({ credits: 0 });
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(0);
  });

  it("admits image generation when allowance remains", async () => {
    const fixture = await seedImageFixture({ credits: 0 });
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
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
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        observedRequestUrl = request.url;
        return HttpResponse.json(falQueueHandle("allowance-image-request"));
      }),
      http.get(FAL_GPT_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a cat covered by allowance" }),
    });

    expect(response.status).toBe(202);
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a cat covered by allowance",
      image_size: "1024x1024",
      num_images: 1,
      output_format: "png",
      quality: "medium",
      background: "auto",
      openai_api_key: "test-openai-key",
    });

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
          content_type: "image/png",
        },
      ],
      prompt: "A cat covered by allowance.",
    });
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    expect(readGenerationResult(await statusResponse.json())).toMatchObject({
      creditsCharged: 50,
      billingCategory: "output_image.medium.standard",
      billingQuantity: 1,
    });
    await expect(orgCredits(fixture)).resolves.toBe(0);
  });

  it("returns 503 when image pricing is not configured", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      missing: MISSING_GPT_IMAGE_2_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    server.use(
      http.post(FAL_GPT_IMAGE_2_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("limits run-scoped zero token image generations after three active built-ins", async () => {
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
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
    const observedAuthorizations: (string | null)[] = [];
    const observedBodies: unknown[] = [];
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorizations.push(request.headers.get("authorization"));
        observedBodies.push(await request.json());
        return HttpResponse.json(falQueueHandle(`pending-image-${falCalls}`));
      }),
    );

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createImageIoTestApp(pricingFixture.resolution);
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
          "This run already has 3 built-in generations in progress, which is the limit. Keep at most 3 in flight and start the next one only after an earlier one finishes.",
        code: "BUILT_IN_RUN_CONCURRENCY_LIMIT",
      },
    });
    expect(falCalls).toBe(3);
    expect(observedAuthorizations).toStrictEqual([
      "Key test-fal-key",
      "Key test-fal-key",
      "Key test-fal-key",
    ]);
    expect(observedBodies).toStrictEqual(
      [0, 1, 2].map((submission) => {
        return {
          prompt: `a pending run image ${submission}`,
          image_size: "1024x1024",
          num_images: 1,
          output_format: "png",
          quality: "medium",
          background: "auto",
          openai_api_key: "test-openai-key",
        };
      }),
    );
    await expect(orgCredits(fixture)).resolves.toBe(10_000);
  });

  it("generates image files for run-scoped zero tokens", async () => {
    const fixture = await seedImageFixture({});
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
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
    const creditsCharged = 50;
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
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
    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
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

    const putInput = putObjectInput();
    expect(putInput.Bucket).toBe(TEST_BUCKET);
    expect(putInput.Key).toMatch(/^artifacts\/[0-9a-z]{10}\.webp$/u);
    expect(url).toBe(`https://cdn.vm7.io/${String(putInput.Key)}`);
    // The embed URL serves the same stored object through the CDN image
    // transform so a PNG-only model still reaches browsers as AVIF/WebP.
    expect(body).toMatchObject({
      embedUrl: `https://cdn.vm7.io/cdn-cgi/image/fit=scale-down,format=auto,quality=85,metadata=none/${String(putInput.Key)}`,
    });
    expect(putInput.Metadata).toStrictEqual({
      "artifact-id": fileId,
      filename: encodeURIComponent(filename),
      "user-id": encodeURIComponent(fixture.userId),
    });
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
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const falStarted = createDeferredPromise<void>(context.signal);
    const markFalStarted = (): void => {
      if (!falStarted.settled()) {
        falStarted.resolve(undefined);
      }
    };
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;

    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedRequestUrl = request.url;
        observedBody = await request.json();
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

    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a late image",
      image_size: "1024x1024",
      num_images: 1,
      output_format: "png",
      quality: "medium",
      background: "auto",
      openai_api_key: "test-openai-key",
    });

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

  it("generates Seedream 5 Lite through BytePlus with 25 percent markup", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: SEEDREAM_5_LITE_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(BYTEPLUS_IMAGE_GENERATIONS_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          created: 1_700_000_000,
          model: "seedream-5-0-lite-260128",
          data: [
            {
              url: BYTEPLUS_SEEDREAM_5_LITE_MEDIA_URL,
              size: "2048x2048",
              output_format: "png",
            },
          ],
        });
      }),
      http.get(BYTEPLUS_SEEDREAM_5_LITE_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a cinematic product still",
        model: "seedream5-lite",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );
    await flushWaitUntilForTest();

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const body = readGenerationResult(await statusResponse.json());
    expect(body).toMatchObject({
      contentType: "image/png",
      creditsCharged: 44,
      model: "seedream-5-0-lite-260128",
      provider: "byteplus",
      imageSize: "2048x2048",
      quality: "model-default",
      background: "auto",
      outputFormat: "png",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 35_000,
      sourceUrl: BYTEPLUS_SEEDREAM_5_LITE_MEDIA_URL,
    });
    expect(observedAuthorization).toBe("Bearer test-byteplus-key");
    expect(observedBody).toStrictEqual({
      model: "seedream-5-0-lite-260128",
      prompt: "a cinematic product still",
      size: "2K",
      output_format: "png",
      response_format: "url",
      watermark: false,
    });
    await expect(orgCredits(fixture)).resolves.toBe(956);
  });

  it("rejects an explicit unsupported Seedream 5 Lite size", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let bytePlusCalls = 0;
    server.use(
      http.post(BYTEPLUS_IMAGE_GENERATIONS_URL, () => {
        bytePlusCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp();
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "an explicitly undersized product still",
        model: "seedream5-lite",
        size: "1024x1024",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message:
          "Unsupported image size for seedream5-lite: 1024x1024; total pixels must be between 3686400 and 16777216",
        code: "BAD_REQUEST",
      },
    });
    expect(bytePlusCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("bills Seedream 5 Pro output tiers and references through BytePlus", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: SEEDREAM_5_PRO_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const observedBodies: unknown[] = [];
    const observedAuthorizations: (string | null)[] = [];
    server.use(
      http.post(BYTEPLUS_IMAGE_GENERATIONS_URL, async ({ request }) => {
        observedAuthorizations.push(request.headers.get("authorization"));
        const requestBody = (await request.json()) as Record<string, unknown>;
        observedBodies.push(requestBody);
        const highTier = requestBody.size === "2K";
        return HttpResponse.json({
          created: 1_700_000_000,
          model: "dola-seedream-5-0-pro-260628",
          data: [
            {
              url: highTier
                ? BYTEPLUS_SEEDREAM_5_PRO_HIGH_MEDIA_URL
                : BYTEPLUS_SEEDREAM_5_PRO_LOW_MEDIA_URL,
              size: highTier ? "2048x2048" : "1536x1536",
              output_format: "jpeg",
            },
          ],
        });
      }),
      http.get(BYTEPLUS_SEEDREAM_5_PRO_LOW_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
      http.get(BYTEPLUS_SEEDREAM_5_PRO_HIGH_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/jpeg" },
        });
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
    const lowResponse = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a precise editorial portrait",
        model: "seedream5-pro",
        size: "1.5K",
        outputFormat: "jpeg",
      }),
    });
    expect(lowResponse.status).toBe(202);
    const lowGenerationId = readAcceptedGenerationId(
      await lowResponse.json(),
      "image",
      fixture.userId,
    );
    await flushWaitUntilForTest();

    const lowStatusResponse = await app.request(
      `/api/zero/built-in-generations/${lowGenerationId}`,
      { headers: authHeaders() },
    );
    const lowBody = readGenerationResult(await lowStatusResponse.json());
    expect(lowBody).toMatchObject({
      creditsCharged: 57,
      model: "dola-seedream-5-0-pro-260628",
      provider: "byteplus",
      imageSize: "1536x1536",
      outputFormat: "jpeg",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 45_000,
      sourceUrl: BYTEPLUS_SEEDREAM_5_PRO_LOW_MEDIA_URL,
    });

    const sourceImageUrls = [
      MOCKUP_IMAGE_URL,
      SECOND_MOCKUP_IMAGE_URL,
      THIRD_MOCKUP_IMAGE_URL,
    ];
    const highResponse = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "combine these references into a campaign image",
        model: "seedream5-pro",
        size: "2K",
        outputFormat: "jpeg",
        imageUrls: sourceImageUrls,
      }),
    });
    expect(highResponse.status).toBe(202);
    const highGenerationId = readAcceptedGenerationId(
      await highResponse.json(),
      "image",
      fixture.userId,
    );
    await flushWaitUntilForTest();

    const highStatusResponse = await app.request(
      `/api/zero/built-in-generations/${highGenerationId}`,
      { headers: authHeaders() },
    );
    const highBody = readGenerationResult(await highStatusResponse.json());
    expect(highBody).toMatchObject({
      creditsCharged: 120,
      model: "dola-seedream-5-0-pro-260628",
      provider: "byteplus",
      imageSize: "2048x2048",
      outputFormat: "jpeg",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 96_000,
      sourceUrl: BYTEPLUS_SEEDREAM_5_PRO_HIGH_MEDIA_URL,
      sourceImageUrls,
    });

    expect(observedAuthorizations).toStrictEqual([
      "Bearer test-byteplus-key",
      "Bearer test-byteplus-key",
    ]);
    expect(observedBodies).toStrictEqual([
      {
        model: "dola-seedream-5-0-pro-260628",
        prompt: "a precise editorial portrait",
        size: "1.5K",
        output_format: "jpeg",
        response_format: "url",
        watermark: false,
      },
      {
        model: "dola-seedream-5-0-pro-260628",
        prompt: "combine these references into a campaign image",
        image: sourceImageUrls,
        size: "2K",
        output_format: "jpeg",
        response_format: "url",
        watermark: false,
      },
    ]);
    await expect(orgCredits(fixture)).resolves.toBe(823);
  });

  it("generates fal image files and settles megapixel usage asynchronously", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: QWEN_IMAGE_PRICING,
    });
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
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_QWEN_IMAGE_URL, async ({ request }) => {
        falCalls += 1;
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
    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
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
    const putInput = putObjectInput();
    expect(putInput.Key).toMatch(/^artifacts\/[0-9a-z]{10}\.jpg$/u);
    expect(putInput.Metadata).toStrictEqual({
      "artifact-id": fileId,
      filename: encodeURIComponent(filename),
      "user-id": encodeURIComponent(fixture.userId),
    });
    expect(putInput.ContentType).toBe("image/jpeg");

    // The megapixel category/quantity are asserted in the result body above;
    // the single settled charge is observable as the exact balance drop.
    await expect(orgCredits(fixture)).resolves.toBe(952);
  });

  it("generates image-to-image through fal with 20 percent markup pricing", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: FLUX_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_FLUX_REDUX_URL, async ({ request }) => {
        falCalls += 1;
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

    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
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
    const pricingFixture = await createScopedImagePricing({
      configured: NANO_BANANA_2_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_NANO_BANANA_2_URL, async ({ request }) => {
        falCalls += 1;
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

    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
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
    const pricingFixture = await createScopedImagePricing({
      configured: NANO_BANANA_2_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_NANO_BANANA_2_EDIT_URL, async ({ request }) => {
        falCalls += 1;
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
    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
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
    const pricingFixture = await createScopedImagePricing({
      configured: BIREFNET_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_BIREFNET_URL, async ({ request }) => {
        falCalls += 1;
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

    const app = createImageIoTestApp(pricingFixture.resolution);
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
      creditsCharged: 0,
      model: "fal-ai/birefnet/v2",
      provider: "fal",
      outputFormat: "png",
      billingCategory: "output_image",
      billingQuantity: 1,
      sourceUrl: FAL_BIREFNET_MEDIA_URL,
      sourceImageUrls: [MOCKUP_IMAGE_URL],
    });
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({ image_url: MOCKUP_IMAGE_URL });
    expect(observedBody).not.toHaveProperty("prompt");
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("upscales images with clarity-upscaler through fal without a prompt", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: CLARITY_UPSCALER_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: Record<string, unknown> | null = null;
    let observedRequestUrl: string | null = null;
    server.use(
      http.post(FAL_CLARITY_UPSCALER_URL, async ({ request }) => {
        falCalls += 1;
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

    const app = createImageIoTestApp(pricingFixture.resolution);
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
      creditsCharged: 150,
      model: "fal-ai/clarity-upscaler",
      provider: "fal",
      imageSize: "2048x2048",
      outputFormat: "png",
      billingCategory: "output_megapixel",
      billingQuantity: 5,
      sourceUrl: FAL_CLARITY_UPSCALER_MEDIA_URL,
      sourceImageUrls: [MOCKUP_IMAGE_URL],
    });
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({ image_url: MOCKUP_IMAGE_URL });
    expect(observedBody).not.toHaveProperty("prompt");
    await expect(orgCredits(fixture)).resolves.toBe(850);
  });

  it("rejects promptless models without a source image", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: BIREFNET_IMAGE_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    server.use(
      http.post(FAL_BIREFNET_URL, () => {
        falCalls += 1;
        return HttpResponse.json({});
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(0);
    await expect(orgCredits(fixture)).resolves.toBe(1000);
  });

  it("records a failed job when fal image generation fails", async () => {
    const fixture = await seedImageFixture({ credits: 1000 });
    const pricingFixture = await createScopedImagePricing({
      configured: GPT_IMAGE_1_PRICING,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let falCalls = 0;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        falCalls += 1;
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const app = createImageIoTestApp(pricingFixture.resolution);
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
    expect(falCalls).toBe(1);
    expect(observedAuthorization).toBe("Key test-fal-key");
    expect(observedBody).toStrictEqual({
      prompt: "a cat",
      image_size: "1024x1024",
      num_images: 1,
      output_format: "png",
      quality: "medium",
      background: "auto",
      openai_api_key: "test-openai-key",
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
