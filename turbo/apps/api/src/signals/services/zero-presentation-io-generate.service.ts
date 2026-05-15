import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";

import { buildFileUrl } from "../../lib/file-url";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { putS3Object } from "../external/s3";
import {
  IMAGE_IO_MODEL,
  OPENAI_IMAGE_GENERATION_URL,
  parseImageGenerationResult,
  recordGeneratedImage$,
  type ImageOptions,
  type ImagePricing,
} from "./zero-image-io-generate.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import { safeAsync, safeJsonParse } from "../utils";

export const OPENAI_PRESENTATION_GENERATION_URL =
  "https://api.openai.com/v1/responses";
export const PRESENTATION_IO_MODEL = "gpt-5.5";

const PRESENTATION_IO_MAX_PROMPT_LENGTH = 32_000;
const PRESENTATION_IO_MIN_SLIDES = 4;
const PRESENTATION_IO_MAX_SLIDES = 20;
const PRESENTATION_IO_DEFAULT_IMAGE_COUNT = 2;
const PRESENTATION_IO_MAX_IMAGES = 8;
const PRESENTATION_CONTENT_TYPE = "text/html";
const PRESENTATION_VISUAL_IMAGE_TIMEOUT_MS = 120_000;
export const PRESENTATION_IO_SYNC_RESPONSE_BUDGET_MS = 90_000;
const PRESENTATION_IO_RECORD_PRESENTATION_RESERVE_MS = 10_000;

const L = logger("ZeroPresentationIoGenerate");

const USAGE_KIND = "model";
const USAGE_PROVIDER = PRESENTATION_IO_MODEL;
const PRESENTATION_INPUT_CATEGORY = "tokens.input";
const PRESENTATION_OUTPUT_CATEGORY = "tokens.output";
const PRESENTATION_PRICING_CATEGORIES = [
  PRESENTATION_INPUT_CATEGORY,
  PRESENTATION_OUTPUT_CATEGORY,
] as const;

const PRESENTATION_STYLES = ["editorial", "swiss"] as const;
const EDITORIAL_THEMES = ["ink", "coral", "forest"] as const;
const SWISS_THEMES = ["ikb", "lemon", "lime", "mono"] as const;
const PRESENTATION_LAYOUTS = [
  "cover",
  "section",
  "statement",
  "bullets",
  "two_column",
  "quote",
  "closing",
] as const;

const PRESENTATION_VISUAL_IMAGE_OPTIONS = {
  model: IMAGE_IO_MODEL,
  provider: "openai",
  size: "1536x864",
  quality: "medium",
  background: "opaque",
  outputFormat: "webp",
  outputCompression: undefined,
  moderation: "auto",
  seed: undefined,
  safetyTolerance: "4",
  enhancePrompt: false,
} as const;

type PresentationStyle = (typeof PRESENTATION_STYLES)[number];
type PresentationLayout = (typeof PRESENTATION_LAYOUTS)[number];
type PresentationPricingCategory =
  (typeof PRESENTATION_PRICING_CATEGORIES)[number];
type ErrorStatus = 400 | 402 | 500 | 502 | 503;

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

interface PresentationPricingRow {
  readonly unitPrice: number;
  readonly unitSize: number;
}

export type PresentationPricing = ReadonlyMap<
  PresentationPricingCategory,
  PresentationPricingRow
>;

interface PresentationOptions {
  readonly prompt: string;
  readonly style: PresentationStyle;
  readonly slideCount: number;
  readonly imageCount: number;
  readonly theme: string;
  readonly audience: string | undefined;
  readonly title: string | undefined;
}

interface PresentationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface OpenAiUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
}

interface SlideSpec {
  readonly layout: PresentationLayout;
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  readonly bullets: readonly string[];
  readonly metric: string;
  readonly note: string;
  readonly visualPrompt: string;
}

interface DeckSpec {
  readonly title: string;
  readonly subtitle: string;
  readonly slides: readonly SlideSpec[];
}

interface ParsedPresentationGeneration {
  readonly deck: DeckSpec;
  readonly usage: PresentationUsage;
  readonly responseId: string | undefined;
  readonly title: string;
  readonly style: PresentationStyle;
  readonly theme: string;
  readonly slideCount: number;
}

interface PresentationVisual {
  readonly slideIndex: number;
  readonly url: string;
  readonly alt: string;
  readonly prompt: string;
  readonly imageId: string;
  readonly filename: string;
  readonly creditsCharged: number;
}

type ParsedPresentationVisualImageGeneration = Exclude<
  ReturnType<typeof parseImageGenerationResult>,
  { readonly status: number }
>;

interface GeneratedPresentationVisualImage {
  readonly slideIndex: number;
  readonly slide: SlideSpec;
  readonly prompt: string;
  readonly generation: ParsedPresentationVisualImageGeneration;
}

interface RecordedPresentation {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly creditsCharged: number;
  readonly model: string;
  readonly style: PresentationStyle;
  readonly theme: string;
  readonly slideCount: number;
  readonly imageCount: number;
  readonly imageUrls: readonly string[];
  readonly imageCreditsCharged: number;
  readonly textCreditsCharged: number;
  readonly title: string;
  readonly responseId: string | undefined;
  readonly usage: PresentationUsage;
}

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

interface ThemeTokens {
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly accentText: string;
  readonly secondary: string;
  readonly line: string;
}

const THEME_TOKENS: Readonly<Record<string, ThemeTokens>> = {
  ink: {
    background: "#f5f5ef",
    text: "#111111",
    muted: "#555555",
    accent: "#d14b2f",
    accentText: "#ffffff",
    secondary: "#0d5c4a",
    line: "#d9d4c8",
  },
  coral: {
    background: "#f7f7f4",
    text: "#151515",
    muted: "#5d5d5d",
    accent: "#e55a47",
    accentText: "#ffffff",
    secondary: "#174f7a",
    line: "#d8d8d2",
  },
  forest: {
    background: "#f4f6f1",
    text: "#0f1714",
    muted: "#526057",
    accent: "#19684f",
    accentText: "#ffffff",
    secondary: "#c14f28",
    line: "#d6ddd4",
  },
  ikb: {
    background: "#f7f7f5",
    text: "#111111",
    muted: "#5b5b5b",
    accent: "#0047ff",
    accentText: "#ffffff",
    secondary: "#ffcc00",
    line: "#d8d8d8",
  },
  lemon: {
    background: "#f8f8f3",
    text: "#111111",
    muted: "#5d5d5d",
    accent: "#f2c300",
    accentText: "#111111",
    secondary: "#006bb6",
    line: "#d8d8d2",
  },
  lime: {
    background: "#f7f8f3",
    text: "#101210",
    muted: "#596158",
    accent: "#77b900",
    accentText: "#111111",
    secondary: "#0057d9",
    line: "#d5ddd0",
  },
  mono: {
    background: "#f6f6f6",
    text: "#101010",
    muted: "#5d5d5d",
    accent: "#111111",
    accentText: "#ffffff",
    secondary: "#777777",
    line: "#d9d9d9",
  },
} as const;

const HTML_ESCAPE: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

const DEFAULT_THEME_TOKENS: ThemeTokens = {
  background: "#f5f5ef",
  text: "#111111",
  muted: "#555555",
  accent: "#d14b2f",
  accentText: "#ffffff",
  secondary: "#0d5c4a",
  line: "#d9d4c8",
} as const;

const PRESENTATION_DECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "subtitle", "slides"],
  properties: {
    title: {
      type: "string",
      description: "Deck title, 3 to 12 words.",
    },
    subtitle: {
      type: "string",
      description: "Deck subtitle or short context line.",
    },
    slides: {
      type: "array",
      minItems: PRESENTATION_IO_MIN_SLIDES,
      maxItems: PRESENTATION_IO_MAX_SLIDES,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "layout",
          "kicker",
          "title",
          "body",
          "bullets",
          "metric",
          "note",
          "visualPrompt",
        ],
        properties: {
          layout: {
            type: "string",
            enum: [...PRESENTATION_LAYOUTS],
          },
          kicker: {
            type: "string",
            description: "Short label above the slide title.",
          },
          title: {
            type: "string",
            description: "Slide title.",
          },
          body: {
            type: "string",
            description: "One concise paragraph or quote text.",
          },
          bullets: {
            type: "array",
            maxItems: 5,
            items: {
              type: "string",
            },
          },
          metric: {
            type: "string",
            description:
              "Optional short metric or emphasis line; empty if none.",
          },
          note: {
            type: "string",
            description:
              "Optional source, caveat, or closing note; empty if none.",
          },
          visualPrompt: {
            type: "string",
            description:
              "A concise image generation prompt for this slide. Describe a visual scene or abstract composition and avoid visible text; empty if the slide should not use an image.",
          },
        },
      },
    },
  },
} as const;

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string, code = "BAD_REQUEST") {
  return { status: 400 as const, body: errorBody(message, code) };
}

export function presentationInternalError(message: string) {
  return {
    status: 500 as const,
    body: errorBody(message, "INTERNAL_SERVER_ERROR"),
  };
}

function badGateway(message: string, code: string) {
  return { status: 502 as const, body: errorBody(message, code) };
}

export function presentationServiceUnavailable(message: string, code: string) {
  return { status: 503 as const, body: errorBody(message, code) };
}

export function presentationInsufficientCredits() {
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

function includesString<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return values.some((candidate) => {
    return candidate === value;
  });
}

function themesForStyle(style: PresentationStyle): readonly string[] {
  return style === "swiss" ? SWISS_THEMES : EDITORIAL_THEMES;
}

function themeList(): string {
  return [...EDITORIAL_THEMES, ...SWISS_THEMES].join(", ");
}

export function parsePresentationOptions(
  body: unknown,
): PresentationOptions | ErrorResponse {
  if (!isRecord(body)) {
    return badRequest("Invalid JSON body");
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    return badRequest("prompt is required");
  }
  if (prompt.length > PRESENTATION_IO_MAX_PROMPT_LENGTH) {
    return badRequest(
      `prompt exceeds ${PRESENTATION_IO_MAX_PROMPT_LENGTH} characters`,
    );
  }

  const style = readString(body, "style", "editorial");
  if (!includesString(PRESENTATION_STYLES, style)) {
    return badRequest(`Unsupported presentation style: ${style}`);
  }

  const rawSlideCount =
    readInteger(body, "slideCount") ?? readInteger(body, "slides");
  if (typeof rawSlideCount === "object") {
    return rawSlideCount;
  }
  const slideCount = rawSlideCount ?? 8;
  if (
    slideCount < PRESENTATION_IO_MIN_SLIDES ||
    slideCount > PRESENTATION_IO_MAX_SLIDES
  ) {
    return badRequest(
      `slideCount must be between ${PRESENTATION_IO_MIN_SLIDES} and ${PRESENTATION_IO_MAX_SLIDES}`,
    );
  }

  const rawImageCount =
    readInteger(body, "imageCount") ?? readInteger(body, "images");
  if (typeof rawImageCount === "object") {
    return rawImageCount;
  }
  const imageCount = rawImageCount ?? PRESENTATION_IO_DEFAULT_IMAGE_COUNT;
  if (imageCount < 0 || imageCount > PRESENTATION_IO_MAX_IMAGES) {
    return badRequest(
      `imageCount must be between 0 and ${PRESENTATION_IO_MAX_IMAGES}`,
    );
  }

  const defaultTheme = themesForStyle(style)[0] ?? "ink";
  const theme = readString(body, "theme", defaultTheme);
  if (!themesForStyle(style).includes(theme)) {
    return badRequest(
      `Unsupported ${style} presentation theme: ${theme}. Available themes: ${themeList()}`,
    );
  }

  return {
    prompt,
    style,
    slideCount,
    imageCount,
    theme,
    audience: readOptionalString(body, "audience", 160),
    title: readOptionalString(body, "title", 120),
  };
}

function mapPricingRows(
  rows: readonly (PresentationPricingRow & { readonly category: string })[],
): PresentationPricing {
  const pricing = new Map<
    PresentationPricingCategory,
    PresentationPricingRow
  >();
  for (const row of rows) {
    if (includesString(PRESENTATION_PRICING_CATEGORIES, row.category)) {
      pricing.set(row.category, {
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }
  return pricing;
}

function getMissingPricing(
  pricing: PresentationPricing,
): readonly PresentationPricingCategory[] {
  return PRESENTATION_PRICING_CATEGORIES.filter((category) => {
    return !pricing.has(category);
  });
}

export const presentationPricing$: Computed<
  Promise<PresentationPricing | null>
> = computed(async (get): Promise<PresentationPricing | null> => {
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
        inArray(usagePricing.category, [...PRESENTATION_PRICING_CATEGORIES]),
      ),
    );

  const pricing = mapPricingRows(rows);
  return getMissingPricing(pricing).length === 0 ? pricing : null;
});

export const checkPresentationCredits$ = command(
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

function presentationInstructions(): string {
  return [
    "You create concise, high-signal web presentations.",
    "Return only the structured deck JSON required by the schema.",
    "Write slide content that can stand on its own in an HTML slideshow.",
    "Prefer specific claims, clear sectioning, and short bullets over long prose.",
    "For visualPrompt, describe a clean image or abstract composition that supports the slide. Avoid visible text, UI screenshots, logos, charts with labels, or typography in the image.",
    "Do not include markdown, HTML, JavaScript, speaker notes, or external links.",
  ].join(" ");
}

function presentationInput(options: PresentationOptions): string {
  const lines = [
    `Create exactly ${options.slideCount} slides.`,
    `Style: ${options.style}. Theme: ${options.theme}.`,
    `Provide visual prompts for up to ${options.imageCount} image-worthy slides; use an empty visualPrompt for slides that do not need an image.`,
    "Use varied layouts. The first slide should be a cover and the last slide should be a closing or synthesis slide.",
  ];

  if (options.title) {
    lines.push(`Requested title: ${options.title}.`);
  }
  if (options.audience) {
    lines.push(`Audience: ${options.audience}.`);
  }

  lines.push(`Prompt:\n${options.prompt}`);
  return lines.join("\n\n");
}

export function createOpenAiPresentationRequest(
  options: PresentationOptions,
): Record<string, unknown> {
  return {
    model: PRESENTATION_IO_MODEL,
    instructions: presentationInstructions(),
    input: presentationInput(options),
    reasoning: { effort: "medium" },
    text: {
      verbosity: "medium",
      format: {
        type: "json_schema",
        name: "presentation_deck",
        strict: true,
        schema: PRESENTATION_DECK_SCHEMA,
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

function parseUsage(usage: OpenAiUsage | undefined): PresentationUsage | null {
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

function readDeckString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const raw = value[key];
  return typeof raw === "string"
    ? normalizeWhitespace(raw).slice(0, maxLength)
    : "";
}

function readDeckStringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] {
  const raw = value[key];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .flatMap((item): string[] => {
      if (typeof item !== "string") {
        return [];
      }
      const normalized = normalizeWhitespace(item);
      return normalized.length > 0 ? [normalized.slice(0, 180)] : [];
    })
    .slice(0, 5);
}

function inferLayout(index: number, totalSlides: number): PresentationLayout {
  if (index === 0) {
    return "cover";
  }
  if (index === totalSlides - 1) {
    return "closing";
  }
  return "bullets";
}

function parseSlide(
  value: unknown,
  index: number,
  totalSlides: number,
): SlideSpec | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawLayout = readDeckString(value, "layout", 40);
  const layout = includesString(PRESENTATION_LAYOUTS, rawLayout)
    ? rawLayout
    : inferLayout(index, totalSlides);
  const title = readDeckString(value, "title", 140);
  const body = readDeckString(value, "body", 700);
  const bullets = readDeckStringArray(value, "bullets");
  const metric = readDeckString(value, "metric", 90);
  const note = readDeckString(value, "note", 180);
  const visualPrompt = readDeckString(value, "visualPrompt", 520);

  if (!title && !body && bullets.length === 0) {
    return null;
  }

  return {
    layout,
    kicker: readDeckString(value, "kicker", 60),
    title: title || `Slide ${index + 1}`,
    body,
    bullets,
    metric,
    note,
    visualPrompt,
  };
}

function parseDeckSpec(
  value: unknown,
  options: PresentationOptions,
): DeckSpec | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawSlides = Array.isArray(value.slides) ? value.slides : [];
  const slides = rawSlides
    .flatMap((slide, index): SlideSpec[] => {
      const parsed = parseSlide(slide, index, rawSlides.length);
      return parsed ? [parsed] : [];
    })
    .slice(0, PRESENTATION_IO_MAX_SLIDES);
  if (slides.length === 0) {
    return null;
  }

  const title =
    options.title ??
    readDeckString(value, "title", 140) ??
    "Generated Presentation";
  const subtitle = readDeckString(value, "subtitle", 220);
  return {
    title: title || "Generated Presentation",
    subtitle,
    slides,
  };
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    return HTML_ESCAPE[char] ?? char;
  });
}

function renderBullets(bullets: readonly string[]): string {
  if (bullets.length === 0) {
    return "";
  }

  return `<ul>${bullets
    .map((bullet) => {
      return `<li>${htmlEscape(bullet)}</li>`;
    })
    .join("")}</ul>`;
}

function renderMetric(metric: string): string {
  return metric ? `<p class="metric">${htmlEscape(metric)}</p>` : "";
}

function renderNote(note: string): string {
  return note ? `<p class="note">${htmlEscape(note)}</p>` : "";
}

function renderBody(body: string): string {
  return body ? `<p class="body">${htmlEscape(body)}</p>` : "";
}

function renderVisual(visual: PresentationVisual | undefined): string {
  if (!visual) {
    return "";
  }

  return `<figure class="visual-frame"><img src="${htmlEscape(
    visual.url,
  )}" alt="${htmlEscape(visual.alt)}"></figure>`;
}

function renderSlideMain(
  slide: SlideSpec,
  visual: PresentationVisual | undefined,
): string {
  const visualHtml = renderVisual(visual);
  if (slide.layout === "cover") {
    return `<div class="cover-block"><div><h1>${htmlEscape(
      slide.title,
    )}</h1>${renderBody(slide.body)}${renderBullets(
      slide.bullets,
    )}</div>${visualHtml}</div>`;
  }

  if (slide.layout === "section" || slide.layout === "statement") {
    return `<div class="statement-block"><h2>${htmlEscape(
      slide.title,
    )}</h2>${renderBody(slide.body)}${renderMetric(
      slide.metric,
    )}${renderBullets(slide.bullets)}${visualHtml}</div>`;
  }

  if (slide.layout === "two_column") {
    return `<div class="two-column"><div><h2>${htmlEscape(
      slide.title,
    )}</h2>${renderBody(slide.body)}${renderMetric(
      slide.metric,
    )}</div><div>${visualHtml || renderBullets(slide.bullets)}</div></div>`;
  }

  if (slide.layout === "quote") {
    return `<figure class="quote-block"><blockquote>${htmlEscape(
      slide.body || slide.title,
    )}</blockquote><figcaption>${htmlEscape(
      slide.title,
    )}</figcaption>${renderNote(slide.note)}</figure>`;
  }

  return `<div class="list-block"><h2>${htmlEscape(
    slide.title,
  )}</h2>${renderMetric(slide.metric)}${renderBody(slide.body)}${renderBullets(
    slide.bullets,
  )}${visualHtml}</div>`;
}

function renderSlide(
  slide: SlideSpec,
  index: number,
  totalSlides: number,
  visual: PresentationVisual | undefined,
): string {
  const slideNumber = String(index + 1).padStart(2, "0");
  const total = String(totalSlides).padStart(2, "0");
  return `<section class="slide slide-${slide.layout}" aria-label="Slide ${
    index + 1
  } of ${totalSlides}"><header><span>${htmlEscape(
    slide.kicker || slide.layout.replace("_", " "),
  )}</span><span>${slideNumber} / ${total}</span></header><main>${renderSlideMain(
    slide,
    visual,
  )}</main><footer>${renderNote(slide.note)}</footer></section>`;
}

const DECK_BASE_STYLE = `
    * { box-sizing: border-box; }
    body {
      margin: 0;
      overflow-x: hidden;
      overflow-y: auto;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button {
      font: inherit;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.78);
      color: var(--text);
      border-radius: 6px;
      min-width: 44px;
      min-height: 40px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    .viewport {
      width: 100vw;
      height: 100vh;
      overflow-x: hidden;
      overflow-y: auto;
    }
    .deck {
      display: flex;
      width: 100%;
      height: 100%;
      transform: translateX(0);
      transition: transform 280ms ease;
    }
    .slide {
      position: relative;
      flex: 0 0 100vw;
      width: 100vw;
      height: 100vh;
      padding: 64px 72px 76px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 28px;
      border-right: 1px solid var(--line);
    }
    .slide::after {
      content: "";
      position: absolute;
      left: 72px;
      right: 72px;
      bottom: 58px;
      height: 6px;
      background: linear-gradient(90deg, var(--accent) 0 52%, var(--secondary) 52% 70%, var(--line) 70%);
    }
    header, footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.4;
    }
    main {
      min-height: 0;
      display: grid;
      align-items: center;
    }
    h1, h2, p, ul, figure, blockquote {
      margin: 0;
    }
    h1 {
      max-width: 1040px;
      font-size: 68px;
      line-height: 0.98;
      font-weight: 760;
    }
    h2 {
      max-width: 980px;
      font-size: 52px;
      line-height: 1.04;
      font-weight: 740;
    }
    .body {
      max-width: 820px;
      margin-top: 24px;
      color: var(--muted);
      font-size: 24px;
      line-height: 1.42;
    }
    .cover-block {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(360px, 0.72fr);
      gap: 54px;
      align-items: end;
    }
    .visual-frame {
      margin: 28px 0 0;
      width: 100%;
      aspect-ratio: 16 / 9;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.54);
    }
    .visual-frame img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .metric {
      display: inline-flex;
      width: fit-content;
      margin-top: 28px;
      padding: 10px 14px;
      border-radius: 6px;
      background: var(--accent);
      color: var(--accent-text);
      font-size: 20px;
      line-height: 1.25;
      font-weight: 700;
    }
    ul {
      max-width: 780px;
      margin-top: 28px;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 16px;
    }
    li {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 14px;
      color: var(--text);
      font-size: 25px;
      line-height: 1.34;
    }
    li::before {
      content: "";
      width: 9px;
      height: 9px;
      margin-top: 12px;
      background: var(--accent);
      border-radius: 50%;
    }
    .two-column {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(320px, 0.95fr);
      gap: 54px;
      align-items: center;
    }
    .two-column ul { margin-top: 0; }
    .quote-block {
      max-width: 1040px;
      display: grid;
      gap: 24px;
    }
    blockquote {
      font-size: 56px;
      line-height: 1.08;
      font-weight: 720;
    }
    figcaption {
      color: var(--accent);
      font-size: 22px;
      font-weight: 700;
    }
    .note {
      color: var(--muted);
      font-size: 15px;
      line-height: 1.4;
    }
    .slide-cover main {
      align-items: end;
    }
    .slide-cover .body {
      color: var(--text);
      font-size: 26px;
    }
    .controls {
      position: fixed;
      right: 24px;
      bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
      z-index: 20;
    }
    .counter {
      min-width: 58px;
      color: var(--muted);
      text-align: center;
      font-size: 14px;
    }
    .progress {
      position: fixed;
      left: 0;
      bottom: 0;
      height: 4px;
      width: 100vw;
      background: rgba(0, 0, 0, 0.08);
      z-index: 30;
    }
    .progress span {
      display: block;
      height: 100%;
      width: 0;
      background: var(--accent);
      transition: width 280ms ease;
    }
`;

const DECK_MOBILE_STYLE = `
    @media (max-width: 820px) {
      .slide {
        padding: 34px 28px 72px;
        gap: 22px;
      }
      .slide::after {
        left: 28px;
        right: 28px;
        bottom: 54px;
      }
      h1 {
        font-size: 42px;
        line-height: 1.04;
      }
      h2 {
        font-size: 34px;
        line-height: 1.08;
      }
      .body, li {
        font-size: 19px;
      }
      blockquote {
        font-size: 34px;
      }
      .two-column {
        grid-template-columns: 1fr;
        gap: 28px;
      }
      .cover-block {
        grid-template-columns: 1fr;
        align-items: center;
        gap: 24px;
      }
      .controls {
        right: 16px;
        bottom: 14px;
      }
    }
`;

function renderDeckStyles(theme: ThemeTokens): string {
  return `<style>
    :root {
      --bg: ${theme.background};
      --text: ${theme.text};
      --muted: ${theme.muted};
      --accent: ${theme.accent};
      --accent-text: ${theme.accentText};
      --secondary: ${theme.secondary};
      --line: ${theme.line};
    }${DECK_BASE_STYLE}${DECK_MOBILE_STYLE}
  </style>`;
}

function renderDeckScript(totalSlides: number): string {
  return `<script>
    const deck = document.getElementById("deck");
    const counter = document.getElementById("counter");
    const progress = document.getElementById("progress");
    const total = ${totalSlides};
    let index = 0;
    function render() {
      deck.style.transform = "translateX(" + (-index * 100) + "vw)";
      counter.textContent = String(index + 1) + " / " + String(total);
      progress.style.width = String(((index + 1) / total) * 100) + "%";
    }
    function go(next) {
      index = Math.max(0, Math.min(total - 1, next));
      render();
    }
    document.getElementById("prev").addEventListener("click", () => go(index - 1));
    document.getElementById("next").addEventListener("click", () => go(index + 1));
    document.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") go(index + 1);
      if (event.key === "ArrowLeft" || event.key === "PageUp" || event.key === "Backspace") go(index - 1);
      if (event.key === "Home") go(0);
      if (event.key === "End") go(total - 1);
    });
    let startX = null;
    document.addEventListener("touchstart", (event) => {
      startX = event.touches[0] ? event.touches[0].clientX : null;
    }, { passive: true });
    document.addEventListener("touchend", (event) => {
      if (startX === null || !event.changedTouches[0]) return;
      const delta = event.changedTouches[0].clientX - startX;
      if (delta < -48) go(index + 1);
      if (delta > 48) go(index - 1);
      startX = null;
    }, { passive: true });
    render();
  </script>`;
}

function renderDeckHtml(
  deck: DeckSpec,
  options: PresentationOptions,
  visuals: readonly PresentationVisual[],
): string {
  const theme = THEME_TOKENS[options.theme] ?? DEFAULT_THEME_TOKENS;
  const visualBySlide = new Map(
    visuals.map((visual) => {
      return [visual.slideIndex, visual];
    }),
  );
  const slidesHtml = deck.slides
    .map((slide, index) => {
      return renderSlide(
        slide,
        index,
        deck.slides.length,
        visualBySlide.get(index),
      );
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(deck.title)}</title>
  ${renderDeckStyles(theme)}
</head>
<body>
  <div class="viewport">
    <div class="deck" id="deck">${slidesHtml}</div>
  </div>
  <div class="controls" aria-label="Presentation controls">
    <button type="button" id="prev" aria-label="Previous slide">&lt;</button>
    <span class="counter" id="counter">1 / ${deck.slides.length}</span>
    <button type="button" id="next" aria-label="Next slide">&gt;</button>
  </div>
  <div class="progress" aria-hidden="true"><span id="progress"></span></div>
  ${renderDeckScript(deck.slides.length)}
</body>
</html>`;
}

export function parsePresentationGenerationResult(
  value: unknown,
  options: PresentationOptions,
): ParsedPresentationGeneration | ErrorResponse {
  const usage = parseUsage(isRecord(value) ? readOpenAiUsage(value.usage) : {});
  if (!usage) {
    return badGateway(
      "Presentation generation usage was not returned",
      "USAGE_UNKNOWN",
    );
  }

  const outputText = readOpenAiOutputText(value);
  if (!outputText) {
    return badGateway(
      "Model returned no presentation data",
      "NO_DECK_RETURNED",
    );
  }

  const parsedJson = safeJsonParse(outputText);
  if (parsedJson === undefined) {
    return badGateway(
      "Model returned invalid presentation data",
      "INVALID_DECK_RETURNED",
    );
  }

  const deck = parseDeckSpec(parsedJson, options);
  if (!deck) {
    return badGateway(
      "Model returned invalid presentation data",
      "INVALID_DECK_RETURNED",
    );
  }

  return {
    deck,
    usage,
    responseId: readResponseId(value),
    title: deck.title,
    style: options.style,
    theme: options.theme,
    slideCount: deck.slides.length,
  };
}

function visualAltText(slide: SlideSpec): string {
  return slide.title ? `Visual for ${slide.title}` : "Presentation visual";
}

function visualPromptForSlide(params: {
  readonly deck: DeckSpec;
  readonly slide: SlideSpec;
  readonly options: PresentationOptions;
}): string {
  return [
    `Create a 16:9 presentation image for "${params.deck.title}".`,
    `Slide: ${params.slide.title}.`,
    `Visual direction: ${params.slide.visualPrompt}.`,
    `Style: ${params.options.style}, theme ${params.options.theme}.`,
    "No visible words, labels, charts with text, logos, watermarks, UI screenshots, or typography.",
  ].join(" ");
}

function selectVisualSlides(
  deck: DeckSpec,
  imageCount: number,
): readonly (readonly [number, SlideSpec])[] {
  if (imageCount <= 0) {
    return [];
  }

  const candidates = deck.slides.flatMap((slide, index) => {
    return slide.visualPrompt ? [[index, slide] as const] : [];
  });
  const preferredLayouts = new Set<PresentationLayout>([
    "cover",
    "section",
    "statement",
    "two_column",
  ]);
  const preferred = candidates.filter(([, slide]) => {
    return preferredLayouts.has(slide.layout);
  });
  const remaining = candidates.filter((candidate) => {
    return !preferred.includes(candidate);
  });
  return [...preferred, ...remaining].slice(0, imageCount);
}

function createVisualImageOptions(prompt: string): ImageOptions {
  return {
    prompt,
    ...PRESENTATION_VISUAL_IMAGE_OPTIONS,
  };
}

function presentationVisualImageTimeoutMs(deadlineAtMs: number | undefined) {
  if (deadlineAtMs === undefined) {
    return PRESENTATION_VISUAL_IMAGE_TIMEOUT_MS;
  }
  const remainingMs =
    deadlineAtMs - now() - PRESENTATION_IO_RECORD_PRESENTATION_RESERVE_MS;
  return Math.min(
    PRESENTATION_VISUAL_IMAGE_TIMEOUT_MS,
    Math.max(0, remainingMs),
  );
}

function loggableError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : String(error);
}

async function generatePresentationVisualImage(
  params: {
    readonly slideIndex: number;
    readonly slide: SlideSpec;
    readonly prompt: string;
    readonly timeoutMs: number;
  },
  signal: AbortSignal,
): Promise<GeneratedPresentationVisualImage | null> {
  const imageOptions = createVisualImageOptions(params.prompt);
  const startedAt = now();
  const result = await safeAsync(async () => {
    const response = await fetch(OPENAI_IMAGE_GENERATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: IMAGE_IO_MODEL,
        prompt: imageOptions.prompt,
        n: 1,
        size: imageOptions.size,
        quality: imageOptions.quality,
        background: imageOptions.background,
        output_format: imageOptions.outputFormat,
        moderation: imageOptions.moderation,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(params.timeoutMs)]),
    });
    signal.throwIfAborted();
    if (!response.ok) {
      L.warn("Presentation visual image request failed", {
        slideIndex: params.slideIndex,
        status: response.status,
        durationMs: now() - startedAt,
      });
      return null;
    }

    const responseBody: unknown = await response.json();
    signal.throwIfAborted();
    const generation = parseImageGenerationResult(responseBody, imageOptions);
    if ("status" in generation) {
      L.warn("Presentation visual image response could not be used", {
        slideIndex: params.slideIndex,
        code: generation.body.error.code,
        durationMs: now() - startedAt,
      });
      return null;
    }

    return {
      slideIndex: params.slideIndex,
      slide: params.slide,
      prompt: params.prompt,
      generation,
    };
  });

  if ("error" in result) {
    signal.throwIfAborted();
    L.warn("Presentation visual image request skipped", {
      slideIndex: params.slideIndex,
      error: loggableError(result.error),
      durationMs: now() - startedAt,
      timeoutMs: params.timeoutMs,
    });
    return null;
  }

  return result.ok;
}

export const generatePresentationVisuals$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly imagePricing: ImagePricing;
      readonly generation: ParsedPresentationGeneration;
      readonly options: PresentationOptions;
      readonly deadlineAtMs?: number;
    },
    signal: AbortSignal,
  ): Promise<readonly PresentationVisual[] | ErrorResponse> => {
    const candidates = selectVisualSlides(
      params.generation.deck,
      params.options.imageCount,
    );
    if (candidates.length === 0) {
      return [];
    }

    const imageTimeoutMs = presentationVisualImageTimeoutMs(
      params.deadlineAtMs,
    );
    if (imageTimeoutMs <= 0) {
      L.warn("Skipping presentation visual images to avoid request timeout", {
        candidateCount: candidates.length,
        deadlineAtMs: params.deadlineAtMs,
      });
      return [];
    }

    const generatedImages = await Promise.all(
      candidates.map(([slideIndex, slide]) => {
        return generatePresentationVisualImage(
          {
            slideIndex,
            slide,
            timeoutMs: imageTimeoutMs,
            prompt: visualPromptForSlide({
              deck: params.generation.deck,
              slide,
              options: params.options,
            }),
          },
          signal,
        );
      }),
    );
    signal.throwIfAborted();

    const visuals: PresentationVisual[] = [];
    for (const image of generatedImages) {
      if (!image) {
        continue;
      }

      const recordedImageResult = await safeAsync(() => {
        return set(
          recordGeneratedImage$,
          {
            orgId: params.orgId,
            userId: params.userId,
            runId: params.runId,
            pricing: params.imagePricing,
            generation: image.generation,
            recordArtifact: false,
          },
          signal,
        );
      });
      signal.throwIfAborted();
      if ("error" in recordedImageResult) {
        L.warn("Presentation visual image record skipped", {
          slideIndex: image.slideIndex,
          error: loggableError(recordedImageResult.error),
        });
        signal.throwIfAborted();
        continue;
      }
      const recordedImage = recordedImageResult.ok;
      visuals.push({
        slideIndex: image.slideIndex,
        url: recordedImage.url,
        alt: visualAltText(image.slide),
        prompt: image.prompt,
        imageId: recordedImage.id,
        filename: recordedImage.filename,
        creditsCharged: recordedImage.creditsCharged,
      });
    }

    return visuals;
  },
);

function estimatePresentationCredits(
  usage: PresentationUsage,
  pricing: PresentationPricing,
): number {
  const rows: readonly (readonly [PresentationPricingCategory, number])[] = [
    [PRESENTATION_INPUT_CATEGORY, usage.inputTokens],
    [PRESENTATION_OUTPUT_CATEGORY, usage.outputTokens],
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

export const recordGeneratedPresentation$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly pricing: PresentationPricing;
      readonly generation: ParsedPresentationGeneration;
      readonly options: PresentationOptions;
      readonly visuals: readonly PresentationVisual[];
    },
    signal: AbortSignal,
  ): Promise<RecordedPresentation> => {
    const writeDb = set(writeDb$);
    const fileId = randomUUID();
    const filename = `presentation-${fileId.slice(0, 8)}.html`;
    const s3Key = `uploads/${params.userId}/${fileId}/${filename}`;
    const htmlBytes = Buffer.from(
      renderDeckHtml(params.generation.deck, params.options, params.visuals),
      "utf8",
    );
    await get(
      putS3Object(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        s3Key,
        htmlBytes,
        PRESENTATION_CONTENT_TYPE,
      ),
    );
    signal.throwIfAborted();

    const url = buildFileUrl(params.userId, fileId, filename);
    await set(
      recordWebUploadedFile$,
      {
        runId: params.runId,
        externalId: fileId,
        userId: params.userId,
        orgId: params.orgId,
        filename,
        contentType: PRESENTATION_CONTENT_TYPE,
        sizeBytes: htmlBytes.byteLength,
        url,
        s3Key,
        metadata: {
          generatedBy: "zero-official-presentation",
          model: PRESENTATION_IO_MODEL,
          style: params.generation.style,
          theme: params.generation.theme,
          slideCount: params.generation.slideCount,
          imageCount: params.visuals.length,
          imageIds: params.visuals.map((visual) => {
            return visual.imageId;
          }),
          imageUrls: params.visuals.map((visual) => {
            return visual.url;
          }),
          title: params.generation.title,
          responseId: params.generation.responseId,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    const usageRows = [
      {
        category: PRESENTATION_INPUT_CATEGORY,
        quantity: params.generation.usage.inputTokens,
      },
      {
        category: PRESENTATION_OUTPUT_CATEGORY,
        quantity: params.generation.usage.outputTokens,
      },
    ].filter((row) => {
      return row.quantity > 0;
    });

    await writeDb.insert(usageEvent).values(
      usageRows.map((row) => {
        return {
          runId: params.runId ?? null,
          idempotencyKey: randomUUID(),
          orgId: params.orgId,
          userId: params.userId,
          kind: USAGE_KIND,
          provider: USAGE_PROVIDER,
          category: row.category,
          quantity: row.quantity,
        };
      }),
    );
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    const textCreditsCharged = estimatePresentationCredits(
      params.generation.usage,
      params.pricing,
    );
    const imageCreditsCharged = params.visuals.reduce((total, visual) => {
      return total + visual.creditsCharged;
    }, 0);

    return {
      id: fileId,
      filename,
      contentType: PRESENTATION_CONTENT_TYPE,
      size: htmlBytes.byteLength,
      url,
      creditsCharged: textCreditsCharged + imageCreditsCharged,
      model: PRESENTATION_IO_MODEL,
      style: params.generation.style,
      theme: params.generation.theme,
      slideCount: params.generation.slideCount,
      imageCount: params.visuals.length,
      imageUrls: params.visuals.map((visual) => {
        return visual.url;
      }),
      imageCreditsCharged,
      textCreditsCharged,
      title: params.generation.title,
      responseId: params.generation.responseId,
      usage: params.generation.usage,
    };
  },
);
