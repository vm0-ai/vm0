import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../app-factory";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { builtInGenerationJobs } from "@vm0/db/schema/built-in-generation-job";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  IMAGE_IO_MODEL,
  imagePricingKey,
  type ImageModel,
} from "../../services/zero-image-io-generate.service";
import {
  OPENAI_WEBSITE_GENERATION_URL,
  WEBSITE_USAGE_KIND,
  WEBSITE_IO_MODEL,
  type WebsitePricing,
} from "../../services/zero-website-io-generate.service";
import { builtInGenerationUsageIdempotencyKey } from "../../services/built-in-generation-usage-idempotency";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { clearAllDetached } from "../../utils";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const IMAGE_BYTES = Buffer.from("fake website visual bytes");
const FAL_GPT_IMAGE_1_URL = "https://fal.run/fal-ai/gpt-image-1/text-to-image";
const FAL_WEBSITE_MEDIA_URL =
  "https://fal.media/files/test/website-visual.webp";
const WEBSITE_PRICING_CATEGORIES = ["tokens.input", "tokens.output"] as const;
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

type WebsitePricingCategory = (typeof WEBSITE_PRICING_CATEGORIES)[number];
type ImagePricingCategory = (typeof IMAGE_PRICING_CATEGORIES)[number];

interface WebsiteFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly insertedPricingCategories: readonly WebsitePricingCategory[];
  readonly insertedImagePricingCategories: readonly ImagePricingCategory[];
}

interface PricingSnapshot {
  readonly category: WebsitePricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface ImagePricingSnapshot {
  readonly provider: ImageModel;
  readonly category: ImagePricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface WebsiteUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function readAcceptedGenerationId(body: unknown, userId: string): string {
  if (
    typeof body !== "object" ||
    body === null ||
    !("generationId" in body) ||
    typeof body.generationId !== "string"
  ) {
    throw new Error("Expected accepted website generation response");
  }
  expect(body).toMatchObject({
    generationId: body.generationId,
    type: "website",
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

function isWebsitePricingCategory(
  value: string,
): value is WebsitePricingCategory {
  return WEBSITE_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

function isImagePricingCategory(value: string): value is ImagePricingCategory {
  return IMAGE_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

function expectedCredits(usage: WebsiteUsage, pricing: WebsitePricing): number {
  const rows: readonly (readonly [WebsitePricingCategory, number])[] = [
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

async function ensureWebsitePricing(): Promise<{
  readonly pricing: WebsitePricing;
  readonly insertedCategories: readonly WebsitePricingCategory[];
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
        eq(usagePricing.kind, WEBSITE_USAGE_KIND),
        eq(usagePricing.provider, WEBSITE_IO_MODEL),
        inArray(usagePricing.category, [...WEBSITE_PRICING_CATEGORIES]),
      ),
    );

  const pricing = new Map<WebsitePricingCategory, PricingSnapshot>();
  for (const row of rows) {
    if (isWebsitePricingCategory(row.category)) {
      pricing.set(row.category, {
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }

  const defaults: Readonly<Record<WebsitePricingCategory, PricingSnapshot>> = {
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

  const insertedCategories: WebsitePricingCategory[] = [];
  for (const category of WEBSITE_PRICING_CATEGORIES) {
    if (!pricing.has(category)) {
      const row = defaults[category];
      await writeDb.insert(usagePricing).values({
        kind: WEBSITE_USAGE_KIND,
        provider: WEBSITE_IO_MODEL,
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

  const defaults: Readonly<
    Record<ImagePricingCategory, Omit<ImagePricingSnapshot, "provider">>
  > = {
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

  const insertedCategories: ImagePricingCategory[] = [];
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
        insertedCategories.push(category);
      }
    }
  }

  return { pricing, insertedCategories };
}

async function seedWebsiteFixture(): Promise<WebsiteFixture> {
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
    credits: 10_000,
  });
  await writeDb.insert(orgMembersMetadata).values({
    orgId,
    userId,
  });
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [FeatureSwitchKey.HostedSites]: true },
  });

  const pricing = await ensureWebsitePricing();
  const imagePricing = await ensureImagePricing();
  return {
    orgId,
    userId,
    insertedPricingCategories: pricing.insertedCategories,
    insertedImagePricingCategories: imagePricing.insertedCategories,
  };
}

async function deleteWebsiteFixture(fixture: WebsiteFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(builtInGenerationJobs)
    .where(eq(builtInGenerationJobs.orgId, fixture.orgId));
  await writeDb.delete(usageEvent).where(eq(usageEvent.orgId, fixture.orgId));
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
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
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
  if (fixture.insertedPricingCategories.length > 0) {
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, WEBSITE_USAGE_KIND),
          eq(usagePricing.provider, WEBSITE_IO_MODEL),
          inArray(usagePricing.category, [
            ...fixture.insertedPricingCategories,
          ]),
        ),
      );
  }
  for (const category of fixture.insertedImagePricingCategories) {
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "image"),
          eq(usagePricing.provider, IMAGE_IO_MODEL),
          eq(usagePricing.category, category),
        ),
      );
  }
}

function websitePayloadJson(options?: {
  readonly visuals?: readonly {
    readonly placement: "hero" | "feature" | "section";
    readonly prompt: string;
    readonly alt: string;
  }[];
}): string {
  return JSON.stringify({
    templateId: "launch",
    siteData: {
      siteName: "Clearpath Observability",
      eyebrow: "Developer operations",
      headline: "Find production issues before customers do",
      subhead:
        "A focused observability workspace for small teams that need fast traces, useful alerts, and calmer on-call rotations.",
      primaryCta: { label: "Start monitoring", href: "#contact" },
      secondaryCta: { label: "See features", href: "#features" },
      highlights: [
        {
          title: "Trace-first debugging",
          body: "Move from alert to exact request path without hunting through dashboards.",
        },
        {
          title: "Compact incident rooms",
          body: "Keep logs, owners, deploys, and decisions in one working view.",
        },
        {
          title: "Human-scale alerts",
          body: "Tune noise down with service-aware thresholds and simple routing.",
        },
      ],
      sections: [
        {
          kicker: "Workflow",
          title: "Built for the first hour of an incident",
          body: "The template emphasizes fast diagnosis, clear ownership, and a direct path from signal to action.",
          bullets: [
            "Surface recent deploys",
            "Group related traces",
            "Record decisions",
          ],
        },
        {
          kicker: "Rollout",
          title: "Adopt it service by service",
          body: "Teams can start with one critical path and expand coverage as alert quality improves.",
          bullets: [
            "Start with checkout",
            "Review noise weekly",
            "Share runbooks",
          ],
        },
      ],
      stats: [
        { value: "15 min", label: "target setup time" },
        { value: "3 views", label: "alert, trace, decision" },
      ],
      footer: {
        title: "Ready for a calmer on-call loop",
        body: "Publish the first service dashboard and use it in the next incident review.",
        cta: { label: "Book a walkthrough", href: "#top" },
      },
      theme: { accent: "cobalt", tone: "light" },
      visuals: options?.visuals ?? [],
    },
  });
}

describe("POST /api/zero/website-io/generate", () => {
  const track = createFixtureTracker<WebsiteFixture>(deleteWebsiteFixture);

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
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a website" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when prompt is missing", async () => {
    const fixture = await track(seedWebsiteFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ template: "launch" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "prompt is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 403 when hosted sites are disabled", async () => {
    mocks.clerk.session(
      "user_hosted_sites_disabled",
      "org_hosted_sites_disabled",
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "A website" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Hosted sites are not enabled", code: "FORBIDDEN" },
    });
  });

  it("generates template content and charges model usage", async () => {
    const fixture = await track(seedWebsiteFixture());
    const { pricing } = await ensureWebsitePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const usage: WebsiteUsage = {
      inputTokens: 1200,
      outputTokens: 480,
      totalTokens: 1680,
    };
    const creditsCharged = expectedCredits(usage, pricing);
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(OPENAI_WEBSITE_GENERATION_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          id: "resp_website_test",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: websitePayloadJson(),
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
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "A launch site for an observability product",
        template: "launch",
        imageCount: 0,
        title: "Clearpath Observability",
        audience: "small engineering teams",
      }),
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      templateId: "launch",
      templateLabel: "Launch site",
      slugSuggestion: "clearpath-observability",
      creditsCharged,
      textCreditsCharged: creditsCharged,
      imageCreditsCharged: 0,
      model: WEBSITE_IO_MODEL,
      imageCount: 0,
      imageModel: IMAGE_IO_MODEL,
      imageUrls: [],
      generatedVisuals: [],
      responseId: "resp_website_test",
      usage,
      siteData: {
        siteName: "Clearpath Observability",
        headline: "Find production issues before customers do",
      },
    });
    expect(observedAuthorization).toBe("Bearer test-openai-key");
    expect(observedBody).toMatchObject({
      model: WEBSITE_IO_MODEL,
      input: expect.stringContaining(
        "A launch site for an observability product",
      ),
      reasoning: { effort: "medium" },
      text: {
        verbosity: "medium",
        format: expect.objectContaining({
          type: "json_schema",
          name: "website_template_content",
          strict: true,
        }),
      },
    });
    expect(observedBody).toMatchObject({
      input: expect.stringContaining("Create up to 0 visual prompts"),
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "generationId" in body &&
        typeof body.generationId === "string"
      )
    ) {
      throw new Error("Expected website response generationId");
    }

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, WEBSITE_USAGE_KIND),
          eq(usageEvent.provider, WEBSITE_IO_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(2);
    expect(usageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId: body.generationId,
            scope: "website-content",
            category: "tokens.input",
          }),
          category: "tokens.input",
          quantity: usage.inputTokens,
          status: "processed",
          billingError: null,
        }),
        expect.objectContaining({
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId: body.generationId,
            scope: "website-content",
            category: "tokens.output",
          }),
          category: "tokens.output",
          quantity: usage.outputTokens,
          status: "processed",
          billingError: null,
        }),
      ]),
    );
  });

  it("generates website visuals asynchronously and charges image usage", async () => {
    const fixture = await track(seedWebsiteFixture());
    const { pricing } = await ensureWebsitePricing();
    const { pricing: imagePricing } = await ensureImagePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const usage: WebsiteUsage = {
      inputTokens: 1400,
      outputTokens: 520,
      totalTokens: 1920,
    };
    const textCreditsCharged = expectedCredits(usage, pricing);
    const imageCreditsCharged = expectedImageCredits(
      IMAGE_IO_MODEL,
      [["output_image.medium.large", 1]],
      imagePricing,
    );
    let observedImageAuthorization: string | null = null;
    let observedImageBody: unknown = null;
    server.use(
      http.post(OPENAI_WEBSITE_GENERATION_URL, () => {
        return HttpResponse.json({
          id: "resp_website_visuals",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: websitePayloadJson({
                    visuals: [
                      {
                        placement: "hero",
                        prompt:
                          "A composed operations room with trace paths and calm incident context",
                        alt: "Abstract observability workspace visual",
                      },
                    ],
                  }),
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
      http.post(FAL_GPT_IMAGE_1_URL, async ({ request }) => {
        observedImageAuthorization = request.headers.get("authorization");
        observedImageBody = await request.json();
        return HttpResponse.json({
          images: [
            {
              url: FAL_WEBSITE_MEDIA_URL,
              width: 1536,
              height: 1024,
              content_type: "image/webp",
            },
          ],
          prompt: "A calm observability workspace visual.",
        });
      }),
      http.get(FAL_WEBSITE_MEDIA_URL, () => {
        return new HttpResponse(IMAGE_BYTES, {
          headers: { "Content-Type": "image/webp" },
        });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "A launch site for an observability product",
        template: "launch",
        imageCount: 1,
      }),
    });

    expect(response.status).toBe(202);
    const generationId = readAcceptedGenerationId(
      await response.json(),
      fixture.userId,
    );

    await clearAllDetached();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `built-in-generation:${generationId}`,
      expect.objectContaining({
        generationId,
        type: "website",
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
      type: "website",
      status: "completed",
    });
    const body = readGenerationResult(statusBody);
    expect(body).toMatchObject({
      generationId,
      creditsCharged: textCreditsCharged + imageCreditsCharged,
      textCreditsCharged,
      imageCreditsCharged,
      model: WEBSITE_IO_MODEL,
      imageCount: 1,
      imageModel: IMAGE_IO_MODEL,
      imageUrls: [expect.stringContaining("https://cdn.vm7.io/artifacts/")],
      generatedVisuals: [
        expect.objectContaining({
          placement: "hero",
          alt: "Abstract observability workspace visual",
          creditsCharged: imageCreditsCharged,
        }),
      ],
      responseId: "resp_website_visuals",
      usage,
    });
    expect(observedImageAuthorization).toBe("Key test-fal-key");
    expect(observedImageBody).toMatchObject({
      image_size: "1536x1024",
      num_images: 1,
      quality: "medium",
      background: "opaque",
      output_format: "webp",
      openai_api_key: "test-openai-key",
      prompt: expect.stringContaining("Clearpath Observability"),
    });
    expect(observedImageBody).toMatchObject({
      prompt: expect.stringContaining("Placement: hero"),
    });

    const putInputs = context.mocks.s3.send.mock.calls.map((call) => {
      return commandInput(call[0]);
    });
    const imagePutInput = putInputs.find((input) => {
      return input.ContentType === "image/webp";
    });
    if (!imagePutInput) {
      throw new Error("Expected website image S3 upload");
    }
    expect(imagePutInput.Body).toStrictEqual(IMAGE_BYTES);
    const imageKey = String(imagePutInput.Key);
    const imageFileId = imageKey.split("/").at(-2);
    if (!imageFileId) {
      throw new Error("Expected website image file id in S3 key");
    }

    const uploadRows = await store
      .set(writeDb$)
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.externalId, imageFileId));
    expect(uploadRows).toHaveLength(0);

    const imageUsageRows = await store
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
    expect(imageUsageRows).toHaveLength(1);
    expect(imageUsageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId,
            scope: "website-visual:0",
            category: "output_image.medium.large",
          }),
          category: "output_image.medium.large",
          quantity: 1,
          status: "processed",
          billingError: null,
        }),
      ]),
    );
  });
});
