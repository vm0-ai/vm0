import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../app-factory";
import { builtInGenerationJobs } from "@vm0/db/schema/built-in-generation-job";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  IMAGE_IO_MODEL,
  imagePricingKey,
  type ImageModel,
} from "../../services/zero-image-io-generate.service";
import {
  OPENAI_PRESENTATION_GENERATION_URL,
  PRESENTATION_IO_MODEL,
  type PresentationPricing,
} from "../../services/zero-presentation-io-generate.service";
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
const IMAGE_BYTES = Buffer.from("fake visual image bytes");
const FAL_GPT_IMAGE_1_URL = "https://fal.run/fal-ai/gpt-image-1/text-to-image";
const FAL_GPT_IMAGE_1_5_URL = "https://fal.run/fal-ai/gpt-image-1.5";
const FAL_PRESENTATION_MEDIA_URL =
  "https://fal.media/files/test/presentation-visual.webp";
const PRESENTATION_PRICING_CATEGORIES = [
  "tokens.input",
  "tokens.output",
] as const;
const IMAGE_PRICING_CATEGORIES = [
  "output_image.low.standard",
  "output_image.low.large",
  "output_image.medium.standard",
  "output_image.medium.large",
  "output_image.high.standard",
  "output_image.high.large",
] as const;
const SELECTED_IMAGE_MODEL = "gpt-image-1.5" satisfies ImageModel;

const tokenRequest = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: '{"user:test-user":["subscribe"]}',
  clientId: "test-user",
  nonce: "test-nonce",
  mac: "test-mac",
});

type PresentationPricingCategory =
  (typeof PRESENTATION_PRICING_CATEGORIES)[number];
type ImagePricingCategory = (typeof IMAGE_PRICING_CATEGORIES)[number];

interface PresentationFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly insertedPricingCategories: readonly PresentationPricingCategory[];
  readonly insertedImagePricingRows: readonly ImagePricingKey[];
}

interface PricingSnapshot {
  readonly category: PresentationPricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface ImagePricingSnapshot {
  readonly provider: ImageModel;
  readonly category: ImagePricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface ImagePricingKey {
  readonly provider: ImageModel;
  readonly category: ImagePricingCategory;
}

interface PresentationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
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
  type: "presentation",
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

function isPresentationPricingCategory(
  value: string,
): value is PresentationPricingCategory {
  return PRESENTATION_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

function isImagePricingCategory(value: string): value is ImagePricingCategory {
  return IMAGE_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

function expectedCredits(
  usage: PresentationUsage,
  pricing: PresentationPricing,
): number {
  const rows: readonly (readonly [PresentationPricingCategory, number])[] = [
    ["tokens.input", usage.inputTokens],
    ["tokens.output", usage.outputTokens],
  ];

  return rows.reduce((total, [category, quantity]) => {
    if (quantity <= 0) {
      return total;
    }
    const row = pricing.get(category);
    if (!row) {
      return total;
    }
    return total + Math.ceil((quantity * row.unitPrice) / row.unitSize);
  }, 0);
}

function expectedImageCredits(
  model: ImageModel,
  rows: readonly (readonly [ImagePricingCategory, number])[],
  pricing: ReadonlyMap<string, ImagePricingSnapshot>,
): number {
  return rows.reduce((total, [category, quantity]) => {
    if (quantity <= 0) {
      return total;
    }
    const row = pricing.get(imagePricingKey(model, category));
    if (!row) {
      return total;
    }
    return total + Math.ceil((quantity * row.unitPrice) / row.unitSize);
  }, 0);
}

function imagePricingDefaults(
  model: ImageModel,
): Readonly<
  Record<ImagePricingCategory, Omit<ImagePricingSnapshot, "provider">>
> {
  if (model === "gpt-image-1.5") {
    return {
      "output_image.low.standard": {
        category: "output_image.low.standard",
        unitPrice: 11,
        unitSize: 1,
      },
      "output_image.low.large": {
        category: "output_image.low.large",
        unitPrice: 16,
        unitSize: 1,
      },
      "output_image.medium.standard": {
        category: "output_image.medium.standard",
        unitPrice: 41,
        unitSize: 1,
      },
      "output_image.medium.large": {
        category: "output_image.medium.large",
        unitPrice: 61,
        unitSize: 1,
      },
      "output_image.high.standard": {
        category: "output_image.high.standard",
        unitPrice: 160,
        unitSize: 1,
      },
      "output_image.high.large": {
        category: "output_image.high.large",
        unitPrice: 240,
        unitSize: 1,
      },
    };
  }
  return {
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
}

async function ensurePresentationPricing(): Promise<{
  readonly pricing: PresentationPricing;
  readonly insertedCategories: readonly PresentationPricingCategory[];
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
        eq(usagePricing.kind, "model"),
        eq(usagePricing.provider, PRESENTATION_IO_MODEL),
        inArray(usagePricing.category, [...PRESENTATION_PRICING_CATEGORIES]),
      ),
    );

  const pricing = new Map<PresentationPricingCategory, PricingSnapshot>();
  for (const row of rows) {
    if (isPresentationPricingCategory(row.category)) {
      pricing.set(row.category, {
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }

  const defaults: Readonly<
    Record<PresentationPricingCategory, PricingSnapshot>
  > = {
    "tokens.input": {
      category: "tokens.input",
      unitPrice: 5000,
      unitSize: 1_000_000,
    },
    "tokens.output": {
      category: "tokens.output",
      unitPrice: 30_000,
      unitSize: 1_000_000,
    },
  };

  const insertedCategories: PresentationPricingCategory[] = [];
  for (const category of PRESENTATION_PRICING_CATEGORIES) {
    if (!pricing.has(category)) {
      const row = defaults[category];
      await writeDb.insert(usagePricing).values({
        kind: "model",
        provider: PRESENTATION_IO_MODEL,
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

async function ensureImagePricing(model: ImageModel = IMAGE_IO_MODEL): Promise<{
  readonly pricing: ReadonlyMap<string, ImagePricingSnapshot>;
  readonly insertedRows: readonly ImagePricingKey[];
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
        eq(usagePricing.provider, model),
        inArray(usagePricing.category, [...IMAGE_PRICING_CATEGORIES]),
      ),
    );

  const pricing = new Map<string, ImagePricingSnapshot>();
  for (const row of rows) {
    if (isImagePricingCategory(row.category)) {
      pricing.set(imagePricingKey(model, row.category), {
        provider: model,
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }

  const defaults = imagePricingDefaults(model);

  const insertedRows: ImagePricingKey[] = [];
  for (const category of IMAGE_PRICING_CATEGORIES) {
    if (!pricing.has(imagePricingKey(model, category))) {
      const row = defaults[category];
      const inserted = await writeDb
        .insert(usagePricing)
        .values({
          kind: "image",
          provider: model,
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
      pricing.set(imagePricingKey(model, category), {
        provider: model,
        ...row,
      });
      if (inserted.length > 0) {
        insertedRows.push({ provider: model, category });
      }
    }
  }

  return { pricing, insertedRows };
}

async function deletePresentationPricingRows(): Promise<
  readonly PricingSnapshot[]
> {
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
        eq(usagePricing.kind, "model"),
        eq(usagePricing.provider, PRESENTATION_IO_MODEL),
        inArray(usagePricing.category, [...PRESENTATION_PRICING_CATEGORIES]),
      ),
    );

  await writeDb
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "model"),
        eq(usagePricing.provider, PRESENTATION_IO_MODEL),
        inArray(usagePricing.category, [...PRESENTATION_PRICING_CATEGORIES]),
      ),
    );

  return rows.filter((row): row is PricingSnapshot => {
    return isPresentationPricingCategory(row.category);
  });
}

async function restorePresentationPricingRows(
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
          kind: "model",
          provider: PRESENTATION_IO_MODEL,
          category: row.category,
          unitPrice: row.unitPrice,
          unitSize: row.unitSize,
        };
      }),
    );
}

async function seedPresentationFixture(options: {
  readonly credits?: number;
  readonly imageModel?: ImageModel;
  readonly withPricing?: boolean;
}): Promise<PresentationFixture> {
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
    ? await ensurePresentationPricing()
    : { insertedCategories: [] };
  const imagePricing = options.withPricing
    ? await ensureImagePricing(options.imageModel ?? IMAGE_IO_MODEL)
    : { insertedRows: [] };

  return {
    orgId,
    userId,
    insertedPricingCategories: pricing.insertedCategories,
    insertedImagePricingRows: imagePricing.insertedRows,
  };
}

async function deletePresentationFixture(
  fixture: PresentationFixture,
): Promise<void> {
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
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, PRESENTATION_IO_MODEL),
          inArray(usagePricing.category, [
            ...fixture.insertedPricingCategories,
          ]),
        ),
      );
  }
  for (const row of fixture.insertedImagePricingRows) {
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "image"),
          eq(usagePricing.provider, row.provider),
          eq(usagePricing.category, row.category),
        ),
      );
  }
}

function presentationDeckJson(): string {
  return JSON.stringify({
    title: "API Migration Plan",
    subtitle: "Reducing integration risk while moving clients forward",
    slides: [
      {
        layout: "cover",
        themeRole: "hero_light",
        visualSlot: "hero_16x9",
        kicker: "Migration",
        title: "API Migration Plan",
        body: "A practical path to move clients without disrupting live traffic.",
        bullets: [],
        metric: "",
        note: "",
        visualPrompt:
          "A confident abstract bridge made of clean blue modular blocks over a quiet production grid",
      },
      {
        layout: "data_hero",
        themeRole: "body_light",
        visualSlot: "concept_16x9",
        kicker: "Risk",
        title: "Where migrations fail",
        body: "Most failures happen at contract edges and rollout timing.",
        bullets: [
          "Inventory active clients",
          "Find schema drift",
          "Stage compatibility windows",
        ],
        metric: "3 control points",
        note: "",
        visualPrompt:
          "Three clean control gates arranged along a precise migration path with subtle risk markers",
      },
      {
        layout: "comparison",
        themeRole: "body_dark",
        visualSlot: "concept_16x9",
        kicker: "Plan",
        title: "Rollout model",
        body: "Ship adapters first, then move traffic by cohort.",
        bullets: [
          "Internal traffic",
          "Low-risk customers",
          "High-volume accounts",
        ],
        metric: "",
        note: "",
        visualPrompt:
          "Layered rollout cohorts moving through a minimal technical pipeline, no text",
      },
      {
        layout: "closing",
        themeRole: "hero_dark",
        visualSlot: "none",
        kicker: "Next",
        title: "Decision path",
        body: "Approve adapter work and schedule the first cohort.",
        bullets: [
          "Lock target contract",
          "Publish migration guide",
          "Review metrics weekly",
        ],
        metric: "",
        note: "Generated test deck.",
        visualPrompt: "",
      },
    ],
  });
}

describe("POST /api/zero/presentation-io/generate", () => {
  const track = createFixtureTracker<PresentationFixture>(
    deletePresentationFixture,
  );
  const trackPricing = createFixtureTracker<readonly PricingSnapshot[]>(
    restorePresentationPricingRows,
  );

  beforeEach(() => {
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
    const response = await app.request("/api/zero/presentation-io/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a deck" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 503 when presentation pricing is not configured", async () => {
    const fixture = await track(seedPresentationFixture({ credits: 1000 }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await trackPricing(deletePresentationPricingRows());
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_PRESENTATION_GENERATION_URL, () => {
        calledOpenAi = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/presentation-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a deck" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Presentation generation pricing is not configured",
        code: "NOT_CONFIGURED",
      },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("generates HTML presentation files for run-scoped zero tokens", async () => {
    const fixture = await track(
      seedPresentationFixture({
        withPricing: true,
        imageModel: SELECTED_IMAGE_MODEL,
      }),
    );
    const { pricing } = await ensurePresentationPricing();
    const { pricing: imagePricing } =
      await ensureImagePricing(SELECTED_IMAGE_MODEL);
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
    const usage: PresentationUsage = {
      inputTokens: 1800,
      outputTokens: 620,
      totalTokens: 2420,
    };
    const textCreditsCharged = expectedCredits(usage, pricing);
    const imageCreditsCharged = expectedImageCredits(
      SELECTED_IMAGE_MODEL,
      [["output_image.medium.large", 1]],
      imagePricing,
    );
    const creditsCharged = textCreditsCharged + imageCreditsCharged;
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    let observedImageAuthorization: string | null = null;
    let observedImageBody: unknown = null;
    server.use(
      http.post(OPENAI_PRESENTATION_GENERATION_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          id: "resp_presentation_test",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: presentationDeckJson(),
                },
              ],
            },
          ],
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          },
        });
      }),
      http.post(FAL_GPT_IMAGE_1_5_URL, async ({ request }) => {
        observedImageAuthorization = request.headers.get("authorization");
        observedImageBody = await request.json();
        return HttpResponse.json({
          images: [
            {
              url: FAL_PRESENTATION_MEDIA_URL,
              width: 1536,
              height: 1024,
              content_type: "image/webp",
            },
          ],
          prompt: "A clean modular bridge over a production grid.",
        });
      }),
      http.get(FAL_PRESENTATION_MEDIA_URL, () => {
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
    const response = await app.request("/api/zero/presentation-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "API migration plan",
        style: "swiss",
        slideCount: 4,
        imageCount: 1,
        imageModel: SELECTED_IMAGE_MODEL,
        theme: "ikb",
        audience: "engineering leadership",
        title: "API Migration Plan",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "presentation",
      fixture.userId,
    );

    await clearAllDetached();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "presentation",
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
      type: "presentation",
      status: "completed",
    });
    const body = readGenerationResult(statusBody);
    expect(body).toMatchObject({
      contentType: "text/html",
      creditsCharged,
      textCreditsCharged,
      imageCreditsCharged,
      model: PRESENTATION_IO_MODEL,
      style: "swiss",
      theme: "ikb",
      slideCount: 4,
      imageCount: 1,
      imageModel: SELECTED_IMAGE_MODEL,
      title: "API Migration Plan",
      responseId: "resp_presentation_test",
      usage,
    });
    expect(observedAuthorization).toBe("Bearer test-openai-key");
    expect(observedBody).toMatchObject({
      model: PRESENTATION_IO_MODEL,
      input: expect.stringContaining("API migration plan"),
      instructions: expect.stringContaining(
        "silently plan the audience, narrative arc",
      ),
      reasoning: { effort: "medium" },
      text: {
        verbosity: "medium",
        format: expect.objectContaining({
          type: "json_schema",
          name: "presentation_deck",
          strict: true,
        }),
      },
    });
    expect(observedBody).toMatchObject({
      input: expect.stringContaining("Deck-planning workflow"),
      text: {
        format: {
          schema: {
            properties: {
              slides: {
                items: {
                  required: expect.arrayContaining(["themeRole", "visualSlot"]),
                  properties: {
                    layout: {
                      enum: expect.arrayContaining([
                        "data_hero",
                        "comparison",
                        "image_hero",
                      ]),
                    },
                    themeRole: {
                      enum: expect.arrayContaining(["hero_light", "body_dark"]),
                    },
                    visualSlot: {
                      enum: expect.arrayContaining([
                        "hero_16x9",
                        "side_16x10",
                        "none",
                      ]),
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(observedImageAuthorization).toBe("Key test-fal-key");
    expect(observedImageBody).toMatchObject({
      image_size: "1536x1024",
      num_images: 1,
      quality: "medium",
      background: "opaque",
      output_format: "webp",
      openai_api_key: "test-openai-key",
    });
    expect(observedImageBody).toMatchObject({
      prompt: expect.stringContaining("API Migration Plan"),
    });
    expect(observedImageBody).toMatchObject({
      prompt: expect.stringContaining("Visual slot: hero_16x9"),
    });
    expect(observedImageBody).toMatchObject({
      prompt: expect.stringContaining("Use this deck palette only: background"),
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body &&
        "url" in body &&
        "size" in body &&
        "imageUrls" in body &&
        Array.isArray(body.imageUrls) &&
        body.imageUrls.length === 1
      )
    ) {
      throw new Error(
        "Expected presentation response id, filename, url, size, and image URL",
      );
    }
    const fileId = String(body.id);
    const filename = String(body.filename);
    const url = String(body.url);
    const imageUrl = String(body.imageUrls[0]);
    expect(filename).toBe(`presentation-${fileId.slice(0, 8)}.html`);
    expect(url).toBe(
      `https://cdn.vm7.io/artifacts/${encodeURIComponent(
        fixture.userId,
      )}/${fileId}/${filename}`,
    );
    expect(imageUrl).toContain("https://cdn.vm7.io/artifacts/");
    expect(imageUrl).toContain("/image-");
    expect(imageUrl).toContain(".webp");

    const putInputs = context.mocks.s3.send.mock.calls.map((call) => {
      return commandInput(call[0]);
    });
    const imagePutInput = putInputs.find((input) => {
      return input.ContentType === "image/webp";
    });
    const putInput = putInputs.find((input) => {
      return input.ContentType === "text/html";
    });
    if (!imagePutInput || !putInput) {
      throw new Error("Expected image and presentation S3 uploads");
    }
    expect(imagePutInput.Bucket).toBe(TEST_BUCKET);
    expect(imagePutInput.ContentType).toBe("image/webp");
    expect(imagePutInput.Body).toStrictEqual(IMAGE_BYTES);
    expect(putInput.Bucket).toBe(TEST_BUCKET);
    expect(putInput.Key).toBe(
      `artifacts/${fixture.userId}/${fileId}/${filename}`,
    );
    expect(putInput.ContentType).toBe("text/html");
    const putBody = putInput.Body;
    expect(Buffer.isBuffer(putBody)).toBeTruthy();
    if (!Buffer.isBuffer(putBody)) {
      throw new Error("Expected S3 put body to be a Buffer");
    }
    const html = putBody.toString("utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>API Migration Plan</title>");
    expect(html).toContain("<img");
    expect(html).toContain(imageUrl);
    expect(html).toContain("slide-data-hero");
    expect(html).toContain("slide-comparison");
    expect(html).toContain("slide-theme-hero-light");
    expect(html).toContain('data-visual-slot="hero_16x9"');
    expect(html).toContain("Presentation controls");
    expect(html).toContain("footer {");
    expect(html).toContain("border-top: 4px solid var(--accent);");
    expect(html).not.toContain(".slide::after");
    expect(html).toContain("scrollbar-gutter: stable;");
    expect(html).toContain("overflow-x: hidden;");
    expect(html).toContain("overflow-y: auto;");
    expect(Number(body.size)).toBe(putBody.byteLength);

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
      contentType: "text/html",
      sizeBytes: putBody.byteLength,
      url,
    });
    expect(uploadRows[0]?.metadata).toMatchObject({
      generatedBy: "zero-official-presentation",
      model: PRESENTATION_IO_MODEL,
      style: "swiss",
      theme: "ikb",
      slideCount: 4,
      imageCount: 1,
      imageModel: SELECTED_IMAGE_MODEL,
      imageUrls: [imageUrl],
      imageIds: [expect.any(String)],
      title: "API Migration Plan",
      responseId: "resp_presentation_test",
      s3Key: `artifacts/${fixture.userId}/${fileId}/${filename}`,
    });
    const runUploadRows = await store
      .set(writeDb$)
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.runId, runId));
    expect(runUploadRows).toHaveLength(1);
    expect(runUploadRows[0]?.externalId).toBe(fileId);

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "model"),
          eq(usageEvent.provider, PRESENTATION_IO_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(2);
    expect(usageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId,
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId,
            scope: "presentation-text",
            category: "tokens.input",
          }),
          category: "tokens.input",
          quantity: usage.inputTokens,
          status: "processed",
          billingError: null,
        }),
        expect.objectContaining({
          runId,
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId,
            scope: "presentation-text",
            category: "tokens.output",
          }),
          category: "tokens.output",
          quantity: usage.outputTokens,
          status: "processed",
          billingError: null,
        }),
      ]),
    );
    const totalCredits = usageRows.reduce((total, row) => {
      return total + (row.creditsCharged ?? 0);
    }, 0);
    expect(totalCredits).toBe(textCreditsCharged);

    const imageUsageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "image"),
          eq(usageEvent.provider, SELECTED_IMAGE_MODEL),
        ),
      );
    expect(imageUsageRows).toHaveLength(1);
    expect(imageUsageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId,
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId,
            scope: "presentation-visual:0",
            category: "output_image.medium.large",
          }),
          category: "output_image.medium.large",
          quantity: 1,
          status: "processed",
          billingError: null,
        }),
      ]),
    );
    const totalImageCredits = imageUsageRows.reduce((total, row) => {
      return total + (row.creditsCharged ?? 0);
    }, 0);
    expect(totalImageCredits).toBe(imageCreditsCharged);
  });

  it("returns 400 when image count exceeds the presentation limit", async () => {
    mocks.clerk.session("user_image_limit", "org_image_limit");
    let calledPresentationGeneration = false;
    let calledImageGeneration = false;
    server.use(
      http.post(OPENAI_PRESENTATION_GENERATION_URL, () => {
        calledPresentationGeneration = true;
        return HttpResponse.json({});
      }),
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        calledImageGeneration = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/presentation-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "image scale plan",
        slideCount: 4,
        imageCount: 9,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "imageCount must be between 0 and 8",
        code: "BAD_REQUEST",
      },
    });
    expect(calledPresentationGeneration).toBeFalsy();
    expect(calledImageGeneration).toBeFalsy();
  });

  it("returns the presentation when visual image generation fails", async () => {
    const fixture = await track(seedPresentationFixture({ withPricing: true }));
    const { pricing } = await ensurePresentationPricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const usage: PresentationUsage = {
      inputTokens: 1200,
      outputTokens: 420,
      totalTokens: 1620,
    };
    const textCreditsCharged = expectedCredits(usage, pricing);
    let calledImageGeneration = false;
    server.use(
      http.post(OPENAI_PRESENTATION_GENERATION_URL, () => {
        return HttpResponse.json({
          id: "resp_presentation_no_visuals",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: presentationDeckJson(),
                },
              ],
            },
          ],
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          },
        });
      }),
      http.post(FAL_GPT_IMAGE_1_URL, () => {
        calledImageGeneration = true;
        return new HttpResponse("image generation timed out", { status: 504 });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/presentation-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "API migration plan",
        style: "swiss",
        slideCount: 4,
        imageCount: 1,
        theme: "ikb",
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      "presentation",
      fixture.userId,
    );

    await clearAllDetached();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "presentation",
        status: "completed",
      }),
    );

    const statusResponse = await app.request(
      `/api/zero/built-in-generations/${generationId}`,
      { headers: authHeaders() },
    );
    expect(statusResponse.status).toBe(200);
    const statusBody: unknown = await statusResponse.json();
    expect(statusBody).toMatchObject({
      generationId,
      type: "presentation",
      status: "completed",
    });
    const body = readGenerationResult(statusBody);
    expect(body).toMatchObject({
      imageCount: 0,
      imageUrls: [],
      creditsCharged: textCreditsCharged,
      textCreditsCharged,
      imageCreditsCharged: 0,
      responseId: "resp_presentation_no_visuals",
    });
    expect(calledImageGeneration).toBeTruthy();

    const putInputs = context.mocks.s3.send.mock.calls.map((call) => {
      return commandInput(call[0]);
    });
    expect(
      putInputs.some((input) => {
        return input.ContentType === "image/webp";
      }),
    ).toBeFalsy();
    expect(
      putInputs.some((input) => {
        return input.ContentType === "text/html";
      }),
    ).toBeTruthy();
  });
});
