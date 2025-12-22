import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Image build status enum
 */
const buildStatusSchema = z.enum(["building", "ready", "error"]);

/**
 * Image info schema (used in list response)
 * Note: Dates are serialized as ISO strings in JSON response
 */
const imageInfoSchema = z.object({
  id: z.string(),
  alias: z.string(),
  versionId: z.string().nullable(), // null for legacy images without versioning
  status: z.string(),
  errorMessage: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/**
 * Create image request schema
 */
const createImageRequestSchema = z.object({
  dockerfile: z.string().min(1, "dockerfile is required"),
  alias: z
    .string()
    .min(3, "alias must be at least 3 characters")
    .max(64, "alias must be at most 64 characters")
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/,
      "alias must be 3-64 characters, alphanumeric and hyphens, start/end with alphanumeric",
    )
    .refine(
      (val) => !val.toLowerCase().startsWith("vm0-"),
      'alias cannot start with "vm0-" (reserved for system templates)',
    )
    .transform((s) => s.toLowerCase()),
  deleteExisting: z.boolean().optional(),
});

/**
 * Create image response schema
 */
const createImageResponseSchema = z.object({
  buildId: z.string(),
  imageId: z.string(),
  alias: z.string(),
  versionId: z.string(), // nanoid(8), unique per build
});

/**
 * Build status response schema
 */
const buildStatusResponseSchema = z.object({
  status: buildStatusSchema,
  logs: z.array(z.string()),
  logsOffset: z.number(),
  error: z.string().optional(),
});

/**
 * Images main contract for /api/images
 */
export const imagesMainContract = c.router({
  /**
   * GET /api/images
   * List all images for authenticated user
   */
  list: {
    method: "GET",
    path: "/api/images",
    responses: {
      200: z.object({
        images: z.array(imageInfoSchema),
      }),
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List user images",
  },

  /**
   * POST /api/images
   * Create an image build task from a Dockerfile
   */
  create: {
    method: "POST",
    path: "/api/images",
    body: createImageRequestSchema,
    responses: {
      202: createImageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create image build",
  },
});

/**
 * Images by ID contract for /api/images/:imageId
 */
export const imagesByIdContract = c.router({
  /**
   * DELETE /api/images/:imageId
   * Delete an image by ID
   */
  delete: {
    method: "DELETE",
    path: "/api/images/:imageId",
    pathParams: z.object({
      imageId: z.string().min(1, "imageId is required"),
    }),
    responses: {
      200: z.object({
        deleted: z.boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete image",
  },
});

/**
 * Image builds contract for /api/images/:imageId/builds/:buildId
 */
export const imageBuildsContract = c.router({
  /**
   * GET /api/images/:imageId/builds/:buildId
   * Query build status with incremental logs
   */
  getStatus: {
    method: "GET",
    path: "/api/images/:imageId/builds/:buildId",
    pathParams: z.object({
      imageId: z.string().min(1, "imageId is required"),
      buildId: z.string().min(1, "buildId is required"),
    }),
    query: z.object({
      logsOffset: z.coerce.number().int().min(0).optional().default(0),
    }),
    responses: {
      200: buildStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get build status",
  },
});

export type ImagesMainContract = typeof imagesMainContract;
export type ImagesByIdContract = typeof imagesByIdContract;
export type ImageBuildsContract = typeof imageBuildsContract;

// Export schemas for reuse
export {
  buildStatusSchema,
  imageInfoSchema,
  createImageRequestSchema,
  createImageResponseSchema,
  buildStatusResponseSchema,
};
