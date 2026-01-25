/**
 * Public API v1 - Volumes Contract
 *
 * Volume storage endpoints for managing input data for agent runs.
 * Volumes are input storage (data provided to agents).
 */
import { z } from "zod";
import { authHeadersSchema, initContract } from "../base";
import {
  publicApiErrorSchema,
  createPaginatedResponseSchema,
  listQuerySchema,
  timestampSchema,
} from "./common";

const c = initContract();

/**
 * Volume schema for public API responses
 */
export const publicVolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  current_version_id: z.string().nullable(),
  size: z.number(), // Total size in bytes
  file_count: z.number(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export type PublicVolume = z.infer<typeof publicVolumeSchema>;

/**
 * Volume version schema
 */
export const volumeVersionSchema = z.object({
  id: z.string(), // SHA-256 content hash
  volume_id: z.string(),
  size: z.number(), // Size in bytes
  file_count: z.number(),
  message: z.string().nullable(), // Optional commit message
  created_by: z.string(),
  created_at: timestampSchema,
});

export type VolumeVersion = z.infer<typeof volumeVersionSchema>;

/**
 * Volume detail schema (includes current version info)
 */
export const publicVolumeDetailSchema = publicVolumeSchema.extend({
  current_version: volumeVersionSchema.nullable(),
});

export type PublicVolumeDetail = z.infer<typeof publicVolumeDetailSchema>;

/**
 * Paginated volumes response
 */
export const paginatedVolumesSchema =
  createPaginatedResponseSchema(publicVolumeSchema);

/**
 * Paginated volume versions response
 */
export const paginatedVolumeVersionsSchema =
  createPaginatedResponseSchema(volumeVersionSchema);

/**
 * Volumes list contract - GET /v1/volumes
 */
export const publicVolumesListContract = c.router({
  list: {
    method: "GET",
    path: "/v1/volumes",
    headers: authHeadersSchema,
    query: listQuerySchema,
    responses: {
      200: paginatedVolumesSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List volumes",
    description: "List all volumes in the current scope with pagination",
  },
});

/**
 * Volume by ID contract - GET /v1/volumes/:id
 */
export const publicVolumeByIdContract = c.router({
  get: {
    method: "GET",
    path: "/v1/volumes/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Volume ID is required"),
    }),
    responses: {
      200: publicVolumeDetailSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get volume",
    description: "Get volume details by ID",
  },
});

/**
 * Volume versions contract - GET /v1/volumes/:id/versions
 */
export const publicVolumeVersionsContract = c.router({
  list: {
    method: "GET",
    path: "/v1/volumes/:id/versions",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Volume ID is required"),
    }),
    query: listQuerySchema,
    responses: {
      200: paginatedVolumeVersionsSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List volume versions",
    description: "List all versions of a volume with pagination",
  },
});

/**
 * Volume download contract - GET /v1/volumes/:id/download
 * Returns 302 redirect to presigned URL for archive.tar.gz
 */
export const publicVolumeDownloadContract = c.router({
  download: {
    method: "GET",
    path: "/v1/volumes/:id/download",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().min(1, "Volume ID is required"),
    }),
    query: z.object({
      version_id: z.string().optional(), // Defaults to current version
    }),
    responses: {
      302: z.undefined(), // Redirect to presigned URL
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Download volume",
    description:
      "Redirect to presigned URL for downloading volume as tar.gz archive. Defaults to current version.",
  },
});

export type PublicVolumesListContract = typeof publicVolumesListContract;
export type PublicVolumeByIdContract = typeof publicVolumeByIdContract;
export type PublicVolumeVersionsContract = typeof publicVolumeVersionsContract;
export type PublicVolumeDownloadContract = typeof publicVolumeDownloadContract;
