import { z } from "zod";

import {
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIALKIT_TOOLS,
  socialKitTranscriptErrorReasonSchema,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolName,
  socialKitRequestSchema,
} from "./social-tools";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export {
  findManagedSocialKitTool,
  managedSocialKitToolCatalog,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIALKIT_TOOLS,
  SOCIALKIT_MAX_INPUT_VALUE_CHARS,
  SOCIALKIT_TRANSCRIPT_ERROR_CODES,
  socialKitTranscriptErrorReasonSchema,
  socialKitRequestSchema,
  type ManagedSocialKitCollection,
  type ManagedSocialKitPagination,
  type ManagedSocialKitReportedTotalField,
  type ManagedSocialKitResultField,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolAvailability,
  type ManagedSocialKitToolDefinition,
  type ManagedSocialKitToolCatalogEntry,
  type ManagedSocialKitToolName,
  type SocialKitTranscriptErrorCode,
  type SocialKitTranscriptErrorReason,
  type SocialKitRequest,
} from "./social-tools";

const c = initContract();

export const socialKitErrorSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    reason: socialKitTranscriptErrorReasonSchema.optional(),
  }),
});

export type SocialKitErrorResponse = z.infer<typeof socialKitErrorSchema>;

/**
 * Keep upstream implementation details out of agent-visible diagnostics.
 *
 * The API still accepts and stores the internal provider codes for server-side
 * accounting and backwards-compatible handling. Callers that render data to
 * an agent should pass codes and messages through these projections first.
 */
export function publicSocialErrorCode(code: string): string {
  return code.replace(/socialkit/giu, "SOCIAL");
}

export function publicSocialErrorMessage(message: string): string {
  return message
    .replace(
      /\b(?:https?:\/\/)?(?:api\.)?socialkit\.dev\b/giu,
      "the social data service",
    )
    .replace(/\bokou\s+socialkit\b/giu, "Okou Social")
    .replace(/\bsocialkit\b/giu, "Okou Social");
}

const SOCIAL_PROVIDER_IDENTITY_KEYS = ["backend", "service", "source"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSocialProviderIdentityKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]/gu, "").toLowerCase();
  return (
    normalized.includes("provider") ||
    normalized.includes("vendor") ||
    SOCIAL_PROVIDER_IDENTITY_KEYS.some((candidate) => {
      return candidate === normalized;
    })
  );
}

/**
 * Remove provider identity extensions from JSON-shaped agent output without
 * rewriting arbitrary social content that happens to mention the provider.
 */
export function redactSocialProviderIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSocialProviderIdentity);
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      isSocialProviderIdentityKey(key) &&
      typeof nested === "string" &&
      /socialkit(?:\.dev)?/iu.test(nested)
    ) {
      continue;
    }
    redacted[key] = redactSocialProviderIdentity(nested);
  }
  return redacted;
}

export const socialKitDownloadPlatformSchema = z.enum([
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
]);

export const socialKitDownloadQualitySchema = z.enum([
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
]);

export const socialKitDownloadFormatSchema = z.enum(["mp4", "m4a"]);

export const socialKitDownloadRequestSchema = z
  .object({
    platform: socialKitDownloadPlatformSchema,
    url: z
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === ""
        );
      }, "URL must use HTTPS without embedded credentials"),
    maxDuration: z.number().int().positive().max(86_400),
    quality: socialKitDownloadQualitySchema.default("720p"),
    format: socialKitDownloadFormatSchema.default("mp4"),
  })
  .strict();

export const socialKitDownloadStatusSchema = z.enum([
  "queued",
  "processing",
  "materializing",
  "artifact_failed",
  "provider_failed",
  "completed",
]);

const socialKitDownloadProviderResultSchema = z.object({
  durationSeconds: z.number().int().nonnegative(),
  fileSizeMB: z.number().nonnegative(),
  creditsCost: z.number().int().positive(),
  title: z.string().max(1000).optional(),
  thumbnail: z.url().max(4096).optional(),
});

const socialKitDownloadArtifactSchema = z.object({
  id: z.string().uuid(),
  url: z.url(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});

export const socialKitDownloadResponseSchema = z.object({
  downloadId: z.string().uuid(),
  status: socialKitDownloadStatusSchema,
  platform: socialKitDownloadPlatformSchema,
  quality: socialKitDownloadQualitySchema,
  format: socialKitDownloadFormatSchema,
  maxDuration: z.number().int().positive(),
  billingCategory: z.literal(MANAGED_SOCIALKIT_BILLING_CATEGORY),
  provider: socialKitDownloadProviderResultSchema.nullable(),
  billing: z
    .object({
      quantity: z.number().int().positive(),
      creditsCharged: z.number().int().nonnegative(),
    })
    .nullable(),
  artifact: socialKitDownloadArtifactSchema.nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      billed: z.boolean(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export type SocialKitDownloadRequest = z.infer<
  typeof socialKitDownloadRequestSchema
>;
export type SocialKitDownloadResponse = z.infer<
  typeof socialKitDownloadResponseSchema
>;

export const socialKitCollectionProviderLimitedReasonSchema = z.enum([
  "reported_total_exceeds_page",
  "provider_ceiling",
  "no_pagination",
]);

export type SocialKitCollectionProviderLimitedReason = z.infer<
  typeof socialKitCollectionProviderLimitedReasonSchema
>;

const reportedTotalSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "reported total must be a safe integer");

const socialKitCollectionSchema = z
  .discriminatedUnion("state", [
    z.object({
      state: z.literal("more"),
      itemsReturned: z.number().int().nonnegative(),
      reportedTotal: reportedTotalSchema.optional(),
      nextInput: z.union([
        z.object({ cursor: z.string().min(1) }).strict(),
        z.object({ page: z.number().int().positive() }).strict(),
      ]),
    }),
    z.object({
      state: z.literal("complete"),
      itemsReturned: z.number().int().nonnegative(),
      reportedTotal: reportedTotalSchema.optional(),
    }),
    z.object({
      state: z.literal("provider_limited"),
      itemsReturned: z.number().int().nonnegative(),
      reason: socialKitCollectionProviderLimitedReasonSchema.optional(),
      reportedTotal: reportedTotalSchema.optional(),
    }),
  ])
  .nullable();

type ToolByName<Name extends ManagedSocialKitToolName> = Extract<
  ManagedSocialKitTool,
  { readonly name: Name }
>;

export type SocialKitInput<Name extends ManagedSocialKitToolName> = z.infer<
  ToolByName<Name>["inputSchema"]
>;

export type SocialKitResult<Name extends ManagedSocialKitToolName> = z.infer<
  ToolByName<Name>["resultSchema"]
>;

type SocialKitResponseFor<Tool extends ManagedSocialKitTool> =
  Tool extends ManagedSocialKitTool
    ? {
        /**
         * The provider discriminator is retained for session/API compatibility.
         * Agent-facing routes project it out before serialization.
         */
        readonly provider?: "socialkit";
        readonly tool: Tool["name"];
        readonly billingCategory: typeof MANAGED_SOCIALKIT_BILLING_CATEGORY;
        readonly billingQuantity: number;
        readonly creditsCharged: number;
        readonly collection: z.infer<typeof socialKitCollectionSchema>;
        readonly result: z.infer<Tool["resultSchema"]>;
      }
    : never;

export type SocialKitResponse = SocialKitResponseFor<ManagedSocialKitTool>;

function responseVariant<Tool extends ManagedSocialKitTool>(tool: Tool) {
  return z.object({
    // Optional so the agent boundary can remove the internal discriminator
    // while older session clients may continue sending/receiving it.
    provider: z.literal("socialkit").optional(),
    tool: z.literal(tool.name),
    billingCategory: z.literal(MANAGED_SOCIALKIT_BILLING_CATEGORY),
    billingQuantity: z.number().int().positive(),
    creditsCharged: z.number().int().nonnegative(),
    collection: socialKitCollectionSchema,
    result: tool.resultSchema,
  });
}

type SocialKitResponseSchemaFor<Tool extends ManagedSocialKitTool> = z.ZodType<
  SocialKitResponseFor<Tool>
>;

type SocialKitResponseSchemas<Tools extends readonly ManagedSocialKitTool[]> = {
  readonly [Index in keyof Tools]: SocialKitResponseSchemaFor<Tools[Index]>;
};

function responseSchemas<
  const Tools extends readonly [
    ManagedSocialKitTool,
    ManagedSocialKitTool,
    ...ManagedSocialKitTool[],
  ],
>(tools: Tools): SocialKitResponseSchemas<Tools> {
  // Array.map cannot retain a const tuple's per-index generic relationship.
  return tools.map(responseVariant) as SocialKitResponseSchemas<Tools>;
}

export const socialKitResponseSchema = z.union(
  responseSchemas(MANAGED_SOCIALKIT_TOOLS),
);

export const socialContract = c.router({
  request: {
    method: "POST",
    path: "/api/social/request",
    headers: authHeadersSchema,
    body: socialKitRequestSchema,
    responses: {
      200: socialKitResponseSchema,
      400: socialKitErrorSchema,
      401: socialKitErrorSchema,
      402: socialKitErrorSchema,
      403: socialKitErrorSchema,
      404: socialKitErrorSchema,
      502: socialKitErrorSchema,
      503: socialKitErrorSchema,
    },
    summary: "Call a typed Okou Social tool",
  },
  createDownload: {
    method: "POST",
    path: "/api/social/downloads",
    headers: authHeadersSchema,
    body: socialKitDownloadRequestSchema,
    responses: {
      202: socialKitDownloadResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start an Okou Social artifact download",
  },
  getDownload: {
    method: "GET",
    path: "/api/social/downloads/:downloadId",
    headers: authHeadersSchema,
    pathParams: z.object({ downloadId: z.string().uuid() }),
    responses: {
      200: socialKitDownloadResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get an Okou Social artifact download",
  },
});

export type SocialContract = typeof socialContract;
