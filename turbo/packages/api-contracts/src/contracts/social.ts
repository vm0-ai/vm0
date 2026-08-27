import { z } from "zod";

import {
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIALKIT_TOOLS,
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
  socialKitRequestSchema,
  type ManagedSocialKitCollection,
  type ManagedSocialKitPagination,
  type ManagedSocialKitResultField,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolDefinition,
  type ManagedSocialKitToolCatalogEntry,
  type ManagedSocialKitToolName,
  type SocialKitRequest,
} from "./social-tools";

const c = initContract();

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
        return new URL(value).protocol === "https:";
      }, "URL must use HTTPS"),
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

const socialKitCollectionSchema = z
  .discriminatedUnion("state", [
    z.object({
      state: z.literal("more"),
      itemsReturned: z.number().int().nonnegative(),
      nextInput: z.union([
        z.object({ cursor: z.string().min(1) }).strict(),
        z.object({ page: z.number().int().positive() }).strict(),
      ]),
    }),
    z.object({
      state: z.literal("complete"),
      itemsReturned: z.number().int().nonnegative(),
    }),
    z.object({
      state: z.literal("provider_limited"),
      itemsReturned: z.number().int().nonnegative(),
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
        readonly provider: "socialkit";
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
    provider: z.literal("socialkit"),
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
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Call a typed managed SocialKit tool",
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
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Start a managed SocialKit artifact download",
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
    summary: "Get a managed SocialKit artifact download",
  },
});

export type SocialContract = typeof socialContract;
