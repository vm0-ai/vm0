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
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  IMAGE_IO_MODEL,
  imagePricingKey,
  OPENAI_IMAGE_GENERATION_URL,
  type ImageUsage,
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
const TEST_BUCKET = "test-user-storages";
const IMAGE_BYTES = Buffer.from("fake image bytes");
const FAL_QWEN_IMAGE_URL = "https://fal.run/fal-ai/qwen-image";
const FAL_MEDIA_URL = "https://fal.media/files/test/qwen.jpg";
const IMAGE_PRICING_CATEGORIES = [
  "tokens.input.text",
  "tokens.input.image",
  "tokens.output.image",
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
  usage: ImageUsage,
  pricing: ReadonlyMap<string, PricingSnapshot>,
): number {
  const rows: readonly (readonly [ImagePricingCategory, number])[] = [
    ["tokens.input.text", usage.textInputTokens],
    ["tokens.input.image", usage.imageInputTokens],
    ["tokens.output.image", usage.imageOutputTokens],
  ];

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
    "tokens.input.text": {
      category: "tokens.input.text",
      unitPrice: 6000,
      unitSize: 1_000_000,
    },
    "tokens.input.image": {
      category: "tokens.input.image",
      unitPrice: 9600,
      unitSize: 1_000_000,
    },
    "tokens.output.image": {
      category: "tokens.output.image",
      unitPrice: 36_000,
      unitSize: 1_000_000,
    },
  };

  for (const category of IMAGE_PRICING_CATEGORIES) {
    if (!pricing.has(imagePricingKey(IMAGE_IO_MODEL, category))) {
      const row = defaults[category];
      await writeDb.insert(usagePricing).values({
        kind: "image",
        provider: IMAGE_IO_MODEL,
        category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
      pricing.set(imagePricingKey(IMAGE_IO_MODEL, category), row);
      insertedCategories.push(category);
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

function isImagePricingCategory(value: string): value is ImagePricingCategory {
  return IMAGE_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

async function deleteImagePricingRows(): Promise<readonly PricingSnapshot[]> {
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

  await writeDb
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "image"),
        eq(usagePricing.provider, IMAGE_IO_MODEL),
        inArray(usagePricing.category, [...IMAGE_PRICING_CATEGORIES]),
      ),
    );

  return rows.filter((row): row is PricingSnapshot => {
    return isImagePricingCategory(row.category);
  });
}

async function restoreImagePricingRows(
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
          kind: "image",
          provider: IMAGE_IO_MODEL,
          category: row.category,
          unitPrice: row.unitPrice,
          unitSize: row.unitSize,
        };
      }),
    );
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
    creditEnabled: true,
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
  const trackPricing = createFixtureTracker<readonly PricingSnapshot[]>(
    restoreImagePricingRows,
  );
  let releasePendingOpenAiResponse: (() => void) | null = null;

  beforeEach(() => {
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
    releasePendingOpenAiResponse?.();
    releasePendingOpenAiResponse = null;
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

  it("rejects empty prompts before OpenAI", async () => {
    const fixture = await track(seedImageFixture({ withPricing: true }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_IMAGE_GENERATION_URL, () => {
        calledOpenAi = true;
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
    expect(calledOpenAi).toBeFalsy();
  });

  it("rejects transparent background requests before OpenAI", async () => {
    const fixture = await track(seedImageFixture({}));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_IMAGE_GENERATION_URL, () => {
        calledOpenAi = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "a transparent badge",
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
    expect(calledOpenAi).toBeFalsy();
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
    await trackPricing(deleteImagePricingRows());
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_IMAGE_GENERATION_URL, () => {
        calledOpenAi = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/image-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a cat" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Image generation pricing is not configured",
        code: "NOT_CONFIGURED",
      },
    });
    expect(calledOpenAi).toBeFalsy();
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
    const usage: ImageUsage = {
      textInputTokens: 1000,
      imageInputTokens: 500,
      imageOutputTokens: 2000,
      totalTokens: 3500,
    };
    const creditsCharged = expectedCredits(usage, pricing);
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(OPENAI_IMAGE_GENERATION_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          data: [
            {
              b64_json: IMAGE_BYTES.toString("base64"),
              revised_prompt: "A small robot paints a sunflower.",
            },
          ],
          output_format: "webp",
          size: "2048x1152",
          quality: "auto",
          background: "opaque",
          usage: {
            total_tokens: usage.totalTokens,
            input_tokens: usage.textInputTokens + usage.imageInputTokens,
            output_tokens: usage.imageOutputTokens,
            input_tokens_details: {
              text_tokens: usage.textInputTokens,
              image_tokens: usage.imageInputTokens,
            },
          },
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
        size: "2048x1152",
        quality: "auto",
        background: "opaque",
        outputFormat: "webp",
        outputCompression: 50,
        moderation: "low",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await clearAllDetached();
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
      imageSize: "2048x1152",
      quality: "auto",
      background: "opaque",
      outputFormat: "webp",
      outputCompression: 50,
      moderation: "low",
      revisedPrompt: "A small robot paints a sunflower.",
      usage,
    });
    expect(observedAuthorization).toBe("Bearer test-openai-key");
    expect(observedBody).toMatchObject({
      model: IMAGE_IO_MODEL,
      prompt: "a small robot painting a sunflower",
      n: 1,
      size: "2048x1152",
      quality: "auto",
      background: "opaque",
      output_format: "webp",
      output_compression: 50,
      moderation: "low",
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
      `http://localhost:3000/f/${encodeURIComponent(
        fixture.userId.replace(/^user_/, ""),
      )}/${fileId}/${filename}`,
    );

    const putInput = commandInput(context.mocks.s3.send.mock.calls[0]?.[0]);
    expect(putInput.Bucket).toBe(TEST_BUCKET);
    expect(putInput.Key).toBe(
      `uploads/${fixture.userId}/${fileId}/${filename}`,
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
      imageSize: "2048x1152",
      quality: "auto",
      background: "opaque",
      outputFormat: "webp",
      outputCompression: 50,
      moderation: "low",
      s3Key: `uploads/${fixture.userId}/${fileId}/${filename}`,
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
    expect(usageRows).toHaveLength(3);
    expect(usageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId,
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId,
            scope: "image",
            category: "tokens.input.text",
          }),
          category: "tokens.input.text",
          quantity: usage.textInputTokens,
          status: "processed",
          billingError: null,
        }),
        expect.objectContaining({
          runId,
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId,
            scope: "image",
            category: "tokens.input.image",
          }),
          category: "tokens.input.image",
          quantity: usage.imageInputTokens,
          status: "processed",
          billingError: null,
        }),
        expect.objectContaining({
          runId,
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId,
            scope: "image",
            category: "tokens.output.image",
          }),
          category: "tokens.output.image",
          quantity: usage.imageOutputTokens,
          status: "processed",
          billingError: null,
        }),
      ]),
    );
    const totalCredits = usageRows.reduce((total, row) => {
      return total + (row.creditsCharged ?? 0);
    }, 0);
    expect(totalCredits).toBe(creditsCharged);
  });

  it("does not complete a job after the status route times it out", async () => {
    const fixture = await track(
      seedImageFixture({ credits: 1000, withPricing: true }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    let released = false;
    let releaseOpenAiResponse = (): void => {};
    const openAiCanFinish = new Promise<void>((resolve) => {
      releaseOpenAiResponse = () => {
        if (!released) {
          released = true;
          resolve();
        }
      };
    });
    releasePendingOpenAiResponse = releaseOpenAiResponse;
    let markOpenAiStarted = (): void => {};
    const openAiStarted = new Promise<void>((resolve) => {
      markOpenAiStarted = resolve;
    });

    server.use(
      http.post(OPENAI_IMAGE_GENERATION_URL, async () => {
        markOpenAiStarted();
        await openAiCanFinish;
        return HttpResponse.json({
          data: [
            {
              b64_json: IMAGE_BYTES.toString("base64"),
              revised_prompt: "A late robot paints a sunflower.",
            },
          ],
          output_format: "webp",
          size: "1024x1024",
          quality: "medium",
          background: "opaque",
          usage: {
            total_tokens: 3000,
            input_tokens: 1000,
            output_tokens: 2000,
            input_tokens_details: {
              text_tokens: 1000,
              image_tokens: 0,
            },
          },
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
    await openAiStarted;

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

    releaseOpenAiResponse();
    await clearAllDetached();
    releasePendingOpenAiResponse = null;

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
    server.use(
      http.post(FAL_QWEN_IMAGE_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
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
      `uploads/${fixture.userId}/${fileId}/${filename}`,
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
  });

  it("records a failed job when OpenAI image generation fails", async () => {
    const fixture = await track(
      seedImageFixture({ credits: 1000, withPricing: true }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    server.use(
      http.post(OPENAI_IMAGE_GENERATION_URL, () => {
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

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "image",
      fixture.userId,
    );

    await clearAllDetached();

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
        code: "INTERNAL_SERVER_ERROR",
      },
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
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
  });
});
