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
});

export type ZeroHostContract = typeof zeroHostContract;
export type HostedSitePrepareRequest = z.infer<
  typeof hostedSitePrepareRequestSchema
>;
export type HostedSitePrepareResponse = z.infer<
  typeof hostedSitePrepareResponseSchema
>;
export type HostedSiteCompleteResponse = z.infer<
  typeof hostedSiteCompleteResponseSchema
>;
