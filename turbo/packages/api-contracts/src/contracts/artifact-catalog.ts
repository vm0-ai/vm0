import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const artifactKindSchema = z.enum([
  "file",
  "hosted-site",
  "image",
  "video",
  "presentation",
]);

/**
 * Static preview descriptor rendered by the catalog grid. Absent when the
 * artifact has no pre-rendered image yet.
 */
const artifactThumbnailSchema = z.object({
  url: z.string(),
});

/**
 * The catalog list returns only the metadata every kind shares. Kind-specific
 * attributes are loaded from the detail endpoint after a card is opened, so the
 * list query never joins a kind table and never exposes `entityId`.
 */
const artifactSummarySchema = z.object({
  id: z.string().uuid(),
  kind: artifactKindSchema,
  title: z.string(),
  thumbnail: artifactThumbnailSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Keyset pagination over `(created_at DESC, id DESC)`. Updates never reorder
 * the list, so a cursor stays stable for the whole scroll session.
 */
const artifactIdPathParamsSchema = z.object({
  artifactId: z.string().uuid(),
});

const artifactCatalogListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
  kind: artifactKindSchema.optional(),
  chatThreadId: z.string().uuid().optional(),
});

const artifactCatalogListResponseSchema = z.object({
  artifacts: z.array(artifactSummarySchema),
  nextCursor: z.string().nullable(),
});

/**
 * The stored file backing a `file`, `image`, or `video` artifact.
 */
const artifactFileSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  previewImageUrl: z.string().nullable(),
});

/**
 * The hosted deployment backing a `hosted-site` or `presentation` artifact.
 * Version state stays owned by the hosted deployment records.
 */
const artifactHostedSiteSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  publicSlug: z.string(),
  url: z.string(),
  deploymentVersion: z.number().nullable(),
  entrypoint: z.string(),
  spaFallback: z.boolean(),
});

const artifactDetailBaseSchema = artifactSummarySchema;

const artifactDetailSchema = z.discriminatedUnion("kind", [
  artifactDetailBaseSchema.extend({
    kind: z.literal("file"),
    file: artifactFileSchema,
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("image"),
    file: artifactFileSchema,
    model: z.string().nullable(),
    provider: z.string().nullable(),
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("video"),
    file: artifactFileSchema,
    model: z.string().nullable(),
    durationSeconds: z.number().nullable(),
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("hosted-site"),
    site: artifactHostedSiteSchema,
  }),
  artifactDetailBaseSchema.extend({
    kind: z.literal("presentation"),
    site: artifactHostedSiteSchema,
  }),
]);

export const artifactCatalogContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/artifacts/catalog",
    headers: authHeadersSchema,
    query: artifactCatalogListQuerySchema,
    responses: {
      200: artifactCatalogListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List the caller's artifacts from the artifact catalog",
  },
  get: {
    method: "GET",
    path: "/api/zero/artifacts/catalog/:artifactId",
    headers: authHeadersSchema,
    pathParams: artifactIdPathParamsSchema,
    responses: {
      200: artifactDetailSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get one artifact with its kind-specific detail",
  },
});

export type ArtifactCatalogContract = typeof artifactCatalogContract;
export type ArtifactCatalogKind = z.infer<typeof artifactKindSchema>;
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;
export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;
