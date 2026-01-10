/**
 * Public API v1 - Volumes Contract
 *
 * Volume storage endpoints for managing input data for agent runs.
 * Volumes are input storage (data provided to agents).
 */
import { z } from "zod";
import { initContract } from "../base";
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
 * Create volume request schema
 */
export const createVolumeRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
      "Name must be lowercase alphanumeric with hyphens, not starting or ending with hyphen",
    ),
});

export type CreateVolumeRequest = z.infer<typeof createVolumeRequestSchema>;

/**
 * File entry for upload (reuse from artifacts)
 */
export const fileEntrySchema = z.object({
  path: z.string(),
  size: z.number(),
  hash: z.string().optional(), // SHA-256 hash of file content
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

/**
 * Prepare upload request - get presigned URLs
 */
export const prepareUploadRequestSchema = z.object({
  files: z.array(fileEntrySchema),
  message: z.string().optional(), // Optional commit message
});

export type PrepareUploadRequest = z.infer<typeof prepareUploadRequestSchema>;

/**
 * Presigned upload URL response
 */
export const presignedUploadSchema = z.object({
  path: z.string(),
  upload_url: z.string(), // Presigned S3 URL
  upload_id: z.string(), // For multi-part uploads
});

export type PresignedUpload = z.infer<typeof presignedUploadSchema>;

/**
 * Prepare upload response
 */
export const prepareUploadResponseSchema = z.object({
  upload_session_id: z.string(),
  files: z.array(presignedUploadSchema),
  expires_at: timestampSchema,
});

export type PrepareUploadResponse = z.infer<typeof prepareUploadResponseSchema>;

/**
 * Commit upload request - finalize the upload
 */
export const commitUploadRequestSchema = z.object({
  upload_session_id: z.string(),
  message: z.string().optional(),
});

export type CommitUploadRequest = z.infer<typeof commitUploadRequestSchema>;

/**
 * Download response with presigned URLs
 */
export const downloadResponseSchema = z.object({
  version_id: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number(),
      download_url: z.string(), // Presigned S3 URL
    }),
  ),
  expires_at: timestampSchema,
});

export type DownloadResponse = z.infer<typeof downloadResponseSchema>;

/**
 * Volumes list contract - GET /v1/volumes, POST /v1/volumes
 */
export const publicVolumesListContract = c.router({
  list: {
    method: "GET",
    path: "/v1/volumes",
    query: listQuerySchema,
    responses: {
      200: paginatedVolumesSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List volumes",
    description: "List all volumes in the current scope with pagination",
  },
  create: {
    method: "POST",
    path: "/v1/volumes",
    body: createVolumeRequestSchema,
    responses: {
      201: publicVolumeDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      409: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Create volume",
    description: "Create a new empty volume container",
  },
});

/**
 * Volume by ID contract - GET /v1/volumes/:id
 */
export const publicVolumeByIdContract = c.router({
  get: {
    method: "GET",
    path: "/v1/volumes/:id",
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
 * Volume upload contract - POST /v1/volumes/:id/upload
 */
export const publicVolumeUploadContract = c.router({
  prepareUpload: {
    method: "POST",
    path: "/v1/volumes/:id/upload",
    pathParams: z.object({
      id: z.string().min(1, "Volume ID is required"),
    }),
    body: prepareUploadRequestSchema,
    responses: {
      200: prepareUploadResponseSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Prepare volume upload",
    description:
      "Get presigned URLs for direct S3 upload. Returns upload URLs for each file.",
  },
});

/**
 * Volume commit contract - POST /v1/volumes/:id/commit
 */
export const publicVolumeCommitContract = c.router({
  commitUpload: {
    method: "POST",
    path: "/v1/volumes/:id/commit",
    pathParams: z.object({
      id: z.string().min(1, "Volume ID is required"),
    }),
    body: commitUploadRequestSchema,
    responses: {
      200: volumeVersionSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Commit volume upload",
    description: "Finalize an upload session and create a new volume version.",
  },
});

/**
 * Volume download contract - GET /v1/volumes/:id/download
 */
export const publicVolumeDownloadContract = c.router({
  download: {
    method: "GET",
    path: "/v1/volumes/:id/download",
    pathParams: z.object({
      id: z.string().min(1, "Volume ID is required"),
    }),
    query: z.object({
      version_id: z.string().optional(), // Defaults to current version
    }),
    responses: {
      200: downloadResponseSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Download volume",
    description:
      "Get presigned URLs for downloading volume files. Defaults to current version.",
  },
});

export type PublicVolumesListContract = typeof publicVolumesListContract;
export type PublicVolumeByIdContract = typeof publicVolumeByIdContract;
export type PublicVolumeVersionsContract = typeof publicVolumeVersionsContract;
export type PublicVolumeUploadContract = typeof publicVolumeUploadContract;
export type PublicVolumeCommitContract = typeof publicVolumeCommitContract;
export type PublicVolumeDownloadContract = typeof publicVolumeDownloadContract;
