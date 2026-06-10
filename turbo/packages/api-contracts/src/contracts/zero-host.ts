import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const ORG_SLUG_HASH_LENGTH = 8;
const RANDOM_SLUG_SUFFIX_LENGTH = 8;
const PUBLIC_SLUG_SEPARATOR_LENGTH = 2;
const MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH = 96;

export const hostedArtifactKindSchema = z.enum([
  "hosted-site",
  "presentation-html",
]);
export type HostedArtifactKind = z.infer<typeof hostedArtifactKindSchema>;

export const hostedSiteSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Site slug must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSiteSlugSuffixSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Site slug suffix must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSitePublicSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Hosted site public slug must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSiteFileSchema = z.object({
  path: z.string().min(1).max(1024).regex(/^\//, "File path must start with /"),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().min(1).max(200),
  immutable: z.boolean().optional(),
});

export const hostedSitePrepareRequestSchema = z
  .object({
    site: hostedSiteSlugSchema,
    slugSuffix: hostedSiteSlugSuffixSchema.optional(),
    artifactKind: hostedArtifactKindSchema.default("hosted-site"),
    spaFallback: z.boolean().default(false),
    files: z.array(hostedSiteFileSchema).min(1).max(5000),
  })
  .superRefine((value, ctx) => {
    const suffixLength = value.slugSuffix?.length ?? RANDOM_SLUG_SUFFIX_LENGTH;
    const publicSlugLength =
      value.site.length +
      ORG_SLUG_HASH_LENGTH +
      suffixLength +
      PUBLIC_SLUG_SEPARATOR_LENGTH;

    if (publicSlugLength > MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.slugSuffix ? ["slugSuffix"] : ["site"],
        message:
          "Hosted site public slug must be 96 characters or fewer; shorten site or slug suffix",
      });
    }
  });

export const hostedSiteUploadSchema = z.object({
  path: z.string(),
  uploadUrl: z.string().url(),
});

export const hostedSiteRedeployPresentationHtmlRequestSchema = z.object({
  url: z.string().url(),
  html: z.string().min(1),
});

export const presentationSpeakerNotesPatchSchema = z.object({
  kind: z.literal("presentation-speaker-notes-patch"),
  version: z.literal(1),
  slides: z
    .array(
      z.object({
        slideId: z.string().min(1),
        speakerNotes: z.string().min(1),
      }),
    )
    .max(500),
});

export const generatePresentationSpeakerNotesRequestSchema = z.object({
  html: z.string().min(1).max(500_000),
  mode: z.literal("fill-empty"),
});

export const hostedSitePrepareResponseSchema = z.object({
  siteId: z.string().uuid(),
  deploymentId: z.string().uuid(),
  publicSlug: z.string(),
  url: z.string().url(),
  uploads: z.array(hostedSiteUploadSchema),
});

export const hostedSiteCompleteResponseSchema = z.object({
  siteId: z.string().uuid(),
  deploymentId: z.string().uuid(),
  publicSlug: z.string(),
  url: z.string().url(),
  status: z.literal("ready"),
});

export const hostedSiteFilesResponseSchema = z.object({
  siteId: z.string().uuid(),
  deploymentId: z.string().uuid(),
  publicSlug: hostedSitePublicSlugSchema,
  url: z.string().url(),
  fileCount: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  files: z.array(hostedSiteFileSchema),
});

export const zeroHostContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/zero/host/deployments/prepare",
    headers: authHeadersSchema,
    body: hostedSitePrepareRequestSchema,
    responses: {
      200: hostedSitePrepareResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare a static hosted-site deployment",
  },
  complete: {
    method: "POST",
    path: "/api/zero/host/deployments/:deploymentId/complete",
    pathParams: z.object({
      deploymentId: z.string().uuid(),
    }),
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: hostedSiteCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Complete a static hosted-site deployment",
  },
  files: {
    method: "GET",
    path: "/api/zero/host/sites/:publicSlug/files",
    pathParams: z.object({
      publicSlug: hostedSitePublicSlugSchema,
    }),
    headers: authHeadersSchema,
    responses: {
      200: hostedSiteFilesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List active hosted-site files for an owned site",
  },
  redeployPresentationHtml: {
    method: "POST",
    path: "/api/zero/host/presentation-html/redeploy",
    headers: authHeadersSchema,
    body: hostedSiteRedeployPresentationHtmlRequestSchema,
    responses: {
      200: hostedSiteCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Redeploy an existing presentation HTML hosted site",
  },
  generatePresentationSpeakerNotes: {
    method: "POST",
    path: "/api/zero/host/presentation-html/speaker-notes",
    headers: authHeadersSchema,
    body: generatePresentationSpeakerNotesRequestSchema,
    responses: {
      200: presentationSpeakerNotesPatchSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Generate speaker notes for an existing presentation HTML",
  },
});

export type ZeroHostContract = typeof zeroHostContract;
export type HostedSitePrepareRequest = z.infer<
  typeof hostedSitePrepareRequestSchema
>;
export type HostedSiteRedeployPresentationHtmlRequest = z.infer<
  typeof hostedSiteRedeployPresentationHtmlRequestSchema
>;
export type GeneratePresentationSpeakerNotesRequest = z.infer<
  typeof generatePresentationSpeakerNotesRequestSchema
>;
export type PresentationSpeakerNotesPatch = z.infer<
  typeof presentationSpeakerNotesPatchSchema
>;
export type HostedSitePrepareResponse = z.infer<
  typeof hostedSitePrepareResponseSchema
>;
export type HostedSiteCompleteResponse = z.infer<
  typeof hostedSiteCompleteResponseSchema
>;
export type HostedSiteFilesResponse = z.infer<
  typeof hostedSiteFilesResponseSchema
>;
