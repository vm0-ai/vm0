import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import {
  zeroWebsiteGenerationPayloadSchema,
  zeroWebsiteTemplateIdSchema,
  zeroWebsiteTemplateRequestSchema,
  type ZeroWebsiteIoGenerateResponse,
  type ZeroWebsiteSiteData,
  type ZeroWebsiteTemplateId,
  type ZeroWebsiteTemplateRequest,
  type ZeroWebsiteGeneratedVisual,
  type ZeroWebsiteVisualPlacement,
  type ZeroWebsiteVisualSpec,
} from "@vm0/api-contracts/contracts/zero-website-io-generate";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import { now } from "../../lib/time";
import { safeJsonParse, settle } from "../utils";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import { builtInGenerationUsageIdempotencyKey } from "./built-in-generation-usage-idempotency";
import {
  IMAGE_IO_MODEL,
  generateImageWithProvider,
  imageModelConfig,
  imageModelList,
  normalizeImageModel,
  parseImageOptions,
  recordGeneratedImage$,
  type ImageModel,
  type ImageOptions,
  type ImagePricing,
  type ParsedImageGeneration,
} from "./zero-image-io-generate.service";

export const OPENAI_WEBSITE_GENERATION_URL =
  "https://api.openai.com/v1/responses";
export const WEBSITE_IO_MODEL = "gpt-5.5";
export const WEBSITE_USAGE_KIND = "website";

const WEBSITE_IO_MAX_PROMPT_LENGTH = 32_000;
const WEBSITE_IO_DEFAULT_IMAGE_COUNT = 1;
const WEBSITE_IO_MAX_IMAGES = 3;
const WEBSITE_VISUAL_IMAGE_TIMEOUT_MS = 120_000;
const WEBSITE_IO_TEMPLATE_LABELS: Readonly<
  Record<ZeroWebsiteTemplateId, string>
> = {
  launch: "Launch site",
  profile: "Profile site",
};

const L = logger("ZeroWebsiteIoGenerate");
const USAGE_KIND = WEBSITE_USAGE_KIND;
const USAGE_PROVIDER = WEBSITE_IO_MODEL;
const WEBSITE_INPUT_CATEGORY = "tokens.input";
const WEBSITE_OUTPUT_CATEGORY = "tokens.output";
const WEBSITE_PRICING_CATEGORIES = [
  WEBSITE_INPUT_CATEGORY,
  WEBSITE_OUTPUT_CATEGORY,
] as const;

type WebsitePricingCategory = (typeof WEBSITE_PRICING_CATEGORIES)[number];
type ErrorStatus = 400 | 402 | 500 | 502 | 503;
type JsonSchema = Record<string, unknown>;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

type ErrorResponse = {
  readonly status: ErrorStatus;
  readonly body: ErrorBody;
};

interface WebsitePricingRow {
  readonly unitPrice: number;
  readonly unitSize: number;
}

export type WebsitePricing = ReadonlyMap<
  WebsitePricingCategory,
  WebsitePricingRow
>;

export interface WebsiteOptions {
  readonly prompt: string;
  readonly template: ZeroWebsiteTemplateRequest;
  readonly imageCount: number;
  readonly imageModel: ImageModel;
  readonly title: string | undefined;
  readonly audience: string | undefined;
}

interface WebsiteUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface OpenAiUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
}

interface ParsedWebsiteGeneration {
  readonly templateId: ZeroWebsiteTemplateId;
  readonly siteData: ZeroWebsiteSiteData;
  readonly usage: WebsiteUsage;
  readonly responseId: string | undefined;
}

interface GeneratedWebsiteVisualImage {
  readonly visualIndex: number;
  readonly visual: ZeroWebsiteVisualSpec;
  readonly prompt: string;
  readonly generation: ParsedImageGeneration;
}

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

const CTA_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "href"],
  properties: {
    label: { type: "string", description: "CTA label, 1 to 5 words." },
    href: {
      type: "string",
      pattern: "^#[a-z0-9-]+$",
      description: "Same-page anchor link, for example #contact.",
    },
  },
} as const;

const HIGHLIGHT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body"],
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
} as const;

const SECTION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kicker", "title", "body", "bullets"],
  properties: {
    kicker: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    bullets: {
      type: "array",
      maxItems: 4,
      items: { type: "string" },
    },
  },
} as const;

const STAT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "value"],
  properties: {
    label: { type: "string" },
    value: { type: "string" },
  },
} as const;

const FOOTER_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body", "cta"],
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    cta: CTA_SCHEMA,
  },
} as const;

const VISUAL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["placement", "prompt", "alt"],
  properties: {
    placement: {
      type: "string",
      enum: ["hero", "feature", "section"],
      description:
        "Where the generated image should appear in the website template.",
    },
    prompt: {
      type: "string",
      description:
        "Image generation prompt. Describe a visual scene or abstract composition; avoid visible text.",
    },
    alt: {
      type: "string",
      description: "Short accessible image description.",
    },
  },
} as const;

const THEME_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accent", "tone"],
  properties: {
    accent: {
      type: "string",
      enum: ["cobalt", "green", "coral", "mono"],
    },
    tone: {
      type: "string",
      enum: ["light", "dark"],
    },
  },
} as const;

const SITE_DATA_REQUIRED = [
  "siteName",
  "eyebrow",
  "headline",
  "subhead",
  "primaryCta",
  "secondaryCta",
  "highlights",
  "sections",
  "stats",
  "footer",
  "theme",
  "visuals",
] as const;

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string, code = "BAD_REQUEST"): ErrorResponse {
  return { status: 400 as const, body: errorBody(message, code) };
}

function badGateway(message: string, code: string): ErrorResponse {
  return { status: 502 as const, body: errorBody(message, code) };
}

export function websiteServiceUnavailable(
  message: string,
  code: string,
): ErrorResponse {
  return { status: 503 as const, body: errorBody(message, code) };
}

export function websiteInsufficientCredits(): ErrorResponse {
  return {
    status: 402 as const,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readString(
  body: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = body[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function readInteger(
  body: Record<string, unknown>,
  key: string,
): number | ErrorResponse | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed)) {
    return badRequest(`${key} must be an integer`);
  }

  return parsed;
}

function isWebsitePricingCategory(
  value: string,
): value is WebsitePricingCategory {
  return WEBSITE_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

export function parseWebsiteOptions(
  body: unknown,
): WebsiteOptions | ErrorResponse {
  if (!isRecord(body)) {
    return badRequest("Invalid JSON body");
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    return badRequest("prompt is required");
  }
  if (prompt.length > WEBSITE_IO_MAX_PROMPT_LENGTH) {
    return badRequest(
      `prompt exceeds ${WEBSITE_IO_MAX_PROMPT_LENGTH} characters`,
    );
  }

  const template = readString(body, "template", "auto");
  const templateResult = zeroWebsiteTemplateRequestSchema.safeParse(template);
  if (!templateResult.success) {
    return badRequest(`Unsupported website template: ${template}`);
  }

  const rawImageCount =
    readInteger(body, "imageCount") ?? readInteger(body, "images");
  if (typeof rawImageCount === "object") {
    return rawImageCount;
  }
  const imageCount = rawImageCount ?? WEBSITE_IO_DEFAULT_IMAGE_COUNT;
  if (
    !Number.isSafeInteger(imageCount) ||
    imageCount < 0 ||
    imageCount > WEBSITE_IO_MAX_IMAGES
  ) {
    return badRequest(
      `imageCount must be between 0 and ${WEBSITE_IO_MAX_IMAGES}`,
    );
  }

  const rawImageModel = readString(body, "imageModel", IMAGE_IO_MODEL);
  const imageModel = normalizeImageModel(rawImageModel);
  if (!imageModel) {
    return badRequest(
      `Unsupported image model: ${rawImageModel}. Available models: ${imageModelList()}`,
    );
  }

  return {
    prompt,
    template: templateResult.data,
    imageCount,
    imageModel,
    title: readOptionalString(body, "title", 120),
    audience: readOptionalString(body, "audience", 160),
  };
}

function mapPricingRows(
  rows: readonly (WebsitePricingRow & { readonly category: string })[],
): WebsitePricing {
  const pricing = new Map<WebsitePricingCategory, WebsitePricingRow>();
  for (const row of rows) {
    if (isWebsitePricingCategory(row.category)) {
      pricing.set(row.category, {
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }
  return pricing;
}

function getMissingPricing(
  pricing: WebsitePricing,
): readonly WebsitePricingCategory[] {
  return WEBSITE_PRICING_CATEGORIES.filter((category) => {
    return !pricing.has(category);
  });
}

export const websitePricing$: Computed<Promise<WebsitePricing | null>> =
  computed(async (get): Promise<WebsitePricing | null> => {
    const db = get(db$);
    const rows = await db
      .select({
        category: usagePricing.category,
        unitPrice: usagePricing.unitPrice,
        unitSize: usagePricing.unitSize,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, USAGE_KIND),
          eq(usagePricing.provider, USAGE_PROVIDER),
          inArray(usagePricing.category, [...WEBSITE_PRICING_CATEGORIES]),
        ),
      );

    const pricing = mapPricingRows(rows);
    return getMissingPricing(pricing).length === 0 ? pricing : null;
  });

export const checkWebsiteCredits$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const { rows } = await writeDb.execute<CreditCheckRow>(sql`
      WITH member AS (
        SELECT credit_enabled FROM org_members_metadata
        WHERE org_id = ${args.orgId} AND user_id = ${args.userId}
        LIMIT 1
      ),
      org AS (
        SELECT credits FROM org_metadata
        WHERE org_id = ${args.orgId}
        LIMIT 1
      ),
      expired AS (
        SELECT COALESCE(SUM(remaining), 0)::bigint AS total
        FROM credit_expires_record
        WHERE org_id = ${args.orgId}
          AND expires_at <= now()
          AND remaining > 0
      )
      SELECT
        (SELECT credit_enabled FROM member) AS credit_enabled,
        (SELECT credits FROM org) AS credits,
        (SELECT total FROM expired) AS unsettled_expired
    `);
    signal.throwIfAborted();

    const row = rows[0];
    if (!row || row.credit_enabled === false || row.credits === null) {
      return false;
    }

    const credits = Number(row.credits);
    const unsettledExpired = Number(row.unsettled_expired ?? 0);
    return credits - unsettledExpired > 0;
  },
);

function websiteInstructions(): string {
  return [
    "You create concise content for prebuilt hosted website templates.",
    "Return only the structured website JSON required by the schema.",
    "Choose launch for product, company, campaign, or event landing pages.",
    "Choose profile for portfolio, personal, creator, venue, service, or case-study pages.",
    "Write copy that is specific to the prompt, practical, and ready to publish.",
    "Use short labels, strong section titles, and compact paragraphs.",
    "For visuals, write concise image prompts that describe scenes or abstract compositions without visible text.",
    "Do not include markdown, HTML, JavaScript, image URLs, external links, legal claims, or unsupported facts.",
    "CTA href values must be same-page anchors such as #contact, #features, #work, or #top.",
  ].join(" ");
}

function websiteInput(options: WebsiteOptions): string {
  const lines = [
    `Template request: ${options.template}.`,
    "Create 3 to 5 highlights, 2 to 4 content sections, and 0 to 4 stats.",
    "Use theme.accent to choose one of cobalt, green, coral, or mono. Use theme.tone for light or dark.",
    `Create up to ${options.imageCount} visual prompts. Prefer one hero image, then feature or section images only when they strengthen the page. Use no visual prompts when the requested count is 0.`,
  ];

  if (options.title) {
    lines.push(`Requested title or site name: ${options.title}.`);
  }
  if (options.audience) {
    lines.push(`Audience: ${options.audience}.`);
  }

  lines.push(`Prompt:\n${options.prompt}`);
  return lines.join("\n\n");
}

function websitePayloadSchema(
  templateOptions: readonly ZeroWebsiteTemplateId[],
  maxVisuals: number,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["templateId", "siteData"],
    properties: {
      templateId: {
        type: "string",
        enum: [...templateOptions],
      },
      siteData: {
        type: "object",
        additionalProperties: false,
        required: [...SITE_DATA_REQUIRED],
        properties: {
          siteName: {
            type: "string",
            description: "Short brand, project, person, or website name.",
          },
          eyebrow: {
            type: "string",
            description: "Short label above the main headline.",
          },
          headline: {
            type: "string",
            description: "Hero headline, 4 to 12 words.",
          },
          subhead: {
            type: "string",
            description: "Hero supporting copy, one concise paragraph.",
          },
          primaryCta: CTA_SCHEMA,
          secondaryCta: CTA_SCHEMA,
          highlights: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: HIGHLIGHT_SCHEMA,
          },
          sections: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: SECTION_SCHEMA,
          },
          stats: {
            type: "array",
            maxItems: 4,
            items: STAT_SCHEMA,
          },
          footer: FOOTER_SCHEMA,
          theme: THEME_SCHEMA,
          visuals: {
            type: "array",
            maxItems: maxVisuals,
            items: VISUAL_SCHEMA,
          },
        },
      },
    },
  };
}

function createOpenAiWebsiteRequest(
  options: WebsiteOptions,
): Record<string, unknown> {
  const templateOptions =
    options.template === "auto"
      ? zeroWebsiteTemplateIdSchema.options
      : [options.template];

  return {
    model: WEBSITE_IO_MODEL,
    instructions: websiteInstructions(),
    input: websiteInput(options),
    reasoning: { effort: "medium" },
    text: {
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "website_template_content",
        strict: true,
        schema: websitePayloadSchema(templateOptions, options.imageCount),
      },
    },
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function readOpenAiUsage(value: unknown): OpenAiUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    input_tokens: readNumber(value.input_tokens),
    output_tokens: readNumber(value.output_tokens),
    total_tokens: readNumber(value.total_tokens),
  };
}

function parseUsage(usage: OpenAiUsage | undefined): WebsiteUsage | null {
  if (!usage) {
    return null;
  }

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  const values = [inputTokens, outputTokens, totalTokens];
  if (
    values.some((value) => {
      return !Number.isFinite(value) || value < 0;
    })
  ) {
    return null;
  }
  if (inputTokens + outputTokens <= 0) {
    return null;
  }

  return { inputTokens, outputTokens, totalTokens };
}

function readOpenAiOutputText(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.output_text === "string" && value.output_text.trim()) {
    return value.output_text.trim();
  }

  const output = Array.isArray(value.output) ? value.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const contentItem of content) {
      if (
        isRecord(contentItem) &&
        contentItem.type === "output_text" &&
        typeof contentItem.text === "string" &&
        contentItem.text.trim()
      ) {
        parts.push(contentItem.text.trim());
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function readResponseId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

function slugifySiteName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 48)
    .replace(/-+$/u, "");
  if (slug.length >= 3) {
    return slug;
  }
  return `site-${now().toString(36)}`;
}

function parseWebsiteGenerationResult(
  value: unknown,
): ParsedWebsiteGeneration | ErrorResponse {
  const usage = parseUsage(isRecord(value) ? readOpenAiUsage(value.usage) : {});
  if (!usage) {
    return badGateway(
      "Website generation usage was not returned",
      "USAGE_UNKNOWN",
    );
  }

  const outputText = readOpenAiOutputText(value);
  if (!outputText) {
    return badGateway(
      "Model returned no website content",
      "NO_WEBSITE_RETURNED",
    );
  }

  const parsedJson = safeJsonParse(outputText);
  if (parsedJson === undefined) {
    return badGateway(
      "Model returned invalid website content",
      "INVALID_WEBSITE_RETURNED",
    );
  }

  const payloadResult =
    zeroWebsiteGenerationPayloadSchema.safeParse(parsedJson);
  if (!payloadResult.success) {
    L.warn("Model returned website content that failed schema validation", {
      issues: payloadResult.error.issues,
    });
    return badGateway(
      "Model returned invalid website content",
      "INVALID_WEBSITE_RETURNED",
    );
  }

  return {
    templateId: payloadResult.data.templateId,
    siteData: payloadResult.data.siteData,
    usage,
    responseId: readResponseId(value),
  };
}

function placementInstruction(placement: ZeroWebsiteVisualPlacement): string {
  if (placement === "hero") {
    return "Hero website image with a strong first-viewport subject and crop-safe negative space.";
  }
  if (placement === "feature") {
    return "Feature support image that reinforces product benefits without looking like a UI screenshot.";
  }
  return "Section support image with a simple composition that can sit beside editorial website copy.";
}

function websitePalette(data: ZeroWebsiteSiteData): string {
  const accent: Readonly<Record<string, string>> = {
    cobalt: "cobalt blue",
    green: "deep green",
    coral: "warm coral",
    mono: "black and white",
  };
  return `${data.theme.tone} tone with ${accent[data.theme.accent]} accent`;
}

function visualPromptForWebsite(params: {
  readonly siteData: ZeroWebsiteSiteData;
  readonly visual: ZeroWebsiteVisualSpec;
  readonly options: WebsiteOptions;
}): string {
  return [
    `Create a 16:9 website image for "${params.siteData.siteName}".`,
    `Placement: ${params.visual.placement}. ${placementInstruction(
      params.visual.placement,
    )}`,
    `Visual direction: ${params.visual.prompt}.`,
    `Website headline: ${params.siteData.headline}.`,
    `Audience: ${params.options.audience ?? "general website visitors"}.`,
    `Use a cohesive ${websitePalette(params.siteData)} palette.`,
    "No visible words, labels, logos, watermarks, UI screenshots, charts with text, or typography.",
  ].join(" ");
}

function websiteVisualImageSizeForModel(model: ImageModel): string {
  const config = imageModelConfig(model);
  if (config.sizeMode === "standard") {
    return "1536x1024";
  }
  return "1536x864";
}

function websiteVisualImageOutputFormatForModel(model: ImageModel): string {
  const formats: readonly string[] = imageModelConfig(model).outputFormats;
  if (formats.includes("webp")) {
    return "webp";
  }
  if (formats.includes("png")) {
    return "png";
  }
  return formats[0] ?? "png";
}

function createWebsiteVisualImageOptions(
  prompt: string,
  imageModel: ImageModel,
): ImageOptions | ErrorResponse {
  return parseImageOptions({
    prompt,
    model: imageModel,
    size: websiteVisualImageSizeForModel(imageModel),
    quality: "medium",
    background: "opaque",
    outputFormat: websiteVisualImageOutputFormatForModel(imageModel),
    moderation: "auto",
    safetyTolerance: "4",
    enhancePrompt: false,
  });
}

function loggableError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : String(error);
}

async function generateWebsiteVisualImage(
  params: {
    readonly visualIndex: number;
    readonly visual: ZeroWebsiteVisualSpec;
    readonly prompt: string;
    readonly imageModel: ImageModel;
  },
  signal: AbortSignal,
): Promise<GeneratedWebsiteVisualImage | null> {
  const startedAt = now();
  const result = await settle(
    (async (): Promise<GeneratedWebsiteVisualImage | null> => {
      const imageOptions = createWebsiteVisualImageOptions(
        params.prompt,
        params.imageModel,
      );
      if ("status" in imageOptions) {
        L.warn("Website visual image options could not be used", {
          visualIndex: params.visualIndex,
          code: imageOptions.body.error.code,
          durationMs: now() - startedAt,
        });
        return null;
      }

      const generation = await generateImageWithProvider(
        imageOptions,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(WEBSITE_VISUAL_IMAGE_TIMEOUT_MS),
        ]),
      );
      signal.throwIfAborted();
      if ("status" in generation) {
        L.warn("Website visual image response could not be used", {
          visualIndex: params.visualIndex,
          code: generation.body.error.code,
          durationMs: now() - startedAt,
        });
        return null;
      }

      return {
        visualIndex: params.visualIndex,
        visual: params.visual,
        prompt: params.prompt,
        generation,
      };
    })(),
  );

  if (!result.ok) {
    signal.throwIfAborted();
    L.warn("Website visual image request skipped", {
      visualIndex: params.visualIndex,
      error: loggableError(result.error),
      durationMs: now() - startedAt,
    });
    return null;
  }

  return result.value;
}

const generateWebsiteVisuals$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly imagePricing: ImagePricing;
      readonly generation: ParsedWebsiteGeneration;
      readonly options: WebsiteOptions;
      readonly generationId: string;
    },
    signal: AbortSignal,
  ): Promise<readonly ZeroWebsiteGeneratedVisual[]> => {
    const candidates = params.generation.siteData.visuals
      .slice(0, params.options.imageCount)
      .filter((visual) => {
        return visual.prompt.trim().length > 0;
      });
    if (candidates.length === 0) {
      return [];
    }

    const generatedImages = await Promise.all(
      candidates.map((visual, visualIndex) => {
        return generateWebsiteVisualImage(
          {
            visualIndex,
            visual,
            imageModel: params.options.imageModel,
            prompt: visualPromptForWebsite({
              siteData: params.generation.siteData,
              visual,
              options: params.options,
            }),
          },
          signal,
        );
      }),
    );
    signal.throwIfAborted();

    const visuals: ZeroWebsiteGeneratedVisual[] = [];
    for (const image of generatedImages) {
      if (!image) {
        continue;
      }

      const recordedImageResult = await settle(
        set(
          recordGeneratedImage$,
          {
            orgId: params.orgId,
            userId: params.userId,
            runId: params.runId,
            pricing: params.imagePricing,
            generation: image.generation,
            recordArtifact: false,
            usageIdempotency: {
              generationId: params.generationId,
              scope: `website-visual:${image.visualIndex}`,
            },
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      if (!recordedImageResult.ok) {
        L.warn("Website visual image record skipped", {
          visualIndex: image.visualIndex,
          error: loggableError(recordedImageResult.error),
        });
        continue;
      }
      const recordedImage = recordedImageResult.value;
      visuals.push({
        placement: image.visual.placement,
        url: recordedImage.url,
        alt: image.visual.alt,
        prompt: image.prompt,
        imageId: recordedImage.id,
        filename: recordedImage.filename,
        creditsCharged: recordedImage.creditsCharged,
      });
    }

    return visuals;
  },
);

function estimateWebsiteCredits(
  usage: WebsiteUsage,
  pricing: WebsitePricing,
): number {
  const rows: readonly (readonly [WebsitePricingCategory, number])[] = [
    [WEBSITE_INPUT_CATEGORY, usage.inputTokens],
    [WEBSITE_OUTPUT_CATEGORY, usage.outputTokens],
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

export const generateWebsite$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly options: WebsiteOptions;
      readonly pricing: WebsitePricing;
      readonly imagePricing: ImagePricing | null;
      readonly generationId?: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroWebsiteIoGenerateResponse | ErrorResponse> => {
    const generationId = params.generationId ?? randomUUID();
    const openAiResponse = await fetch(OPENAI_WEBSITE_GENERATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createOpenAiWebsiteRequest(params.options)),
      signal,
    });
    signal.throwIfAborted();

    if (!openAiResponse.ok) {
      const errorBody = await openAiResponse.text();
      signal.throwIfAborted();
      L.error("OpenAI website request failed", {
        status: openAiResponse.status,
        body: errorBody,
      });
      return badGateway("Website generation failed", "INTERNAL_SERVER_ERROR");
    }

    const responseBody: unknown = await openAiResponse.json();
    signal.throwIfAborted();
    const generation = parseWebsiteGenerationResult(responseBody);
    if ("status" in generation) {
      return generation;
    }

    const generatedVisuals =
      params.options.imageCount > 0 && params.imagePricing
        ? await set(
            generateWebsiteVisuals$,
            {
              orgId: params.orgId,
              userId: params.userId,
              runId: params.runId,
              imagePricing: params.imagePricing,
              generation,
              options: params.options,
              generationId,
            },
            signal,
          )
        : [];
    signal.throwIfAborted();

    const usageRows = [
      {
        category: WEBSITE_INPUT_CATEGORY,
        quantity: generation.usage.inputTokens,
      },
      {
        category: WEBSITE_OUTPUT_CATEGORY,
        quantity: generation.usage.outputTokens,
      },
    ].filter((row) => {
      return row.quantity > 0;
    });

    await set(writeDb$)
      .insert(usageEvent)
      .values(
        usageRows.map((row) => {
          return {
            runId: params.runId ?? null,
            idempotencyKey: builtInGenerationUsageIdempotencyKey({
              generationId,
              scope: "website-content",
              category: row.category,
            }),
            orgId: params.orgId,
            userId: params.userId,
            kind: USAGE_KIND,
            provider: USAGE_PROVIDER,
            category: row.category,
            quantity: row.quantity,
          };
        }),
      )
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    const generatedVisualList = [...generatedVisuals];
    const textCreditsCharged = estimateWebsiteCredits(
      generation.usage,
      params.pricing,
    );
    const imageCreditsCharged = generatedVisualList.reduce((total, visual) => {
      return total + visual.creditsCharged;
    }, 0);

    return {
      generationId,
      templateId: generation.templateId,
      templateLabel: WEBSITE_IO_TEMPLATE_LABELS[generation.templateId],
      slugSuggestion: slugifySiteName(generation.siteData.siteName),
      siteData: generation.siteData,
      creditsCharged: textCreditsCharged + imageCreditsCharged,
      textCreditsCharged,
      imageCreditsCharged,
      model: WEBSITE_IO_MODEL,
      imageCount: generatedVisualList.length,
      imageModel: params.options.imageModel,
      imageUrls: generatedVisualList.map((visual) => {
        return visual.url;
      }),
      generatedVisuals: generatedVisualList,
      responseId: generation.responseId,
      usage: generation.usage,
    };
  },
);
