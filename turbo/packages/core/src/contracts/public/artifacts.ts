/**
 * Public API v1 - Artifacts Contract
 *
 * Artifact storage endpoints for managing work products from agent runs.
 * Artifacts are output storage (work products created by agents).
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
 * Artifact schema for public API responses
 */
export const publicArtifactSchema = z.object({
  id: z.string(),
  name: z.string(),
  current_version_id: z.string().nullable(),
  size: z.number(), // Total size in bytes
  file_count: z.number(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export type PublicArtifact = z.infer<typeof publicArtifactSchema>;

/**
 * Artifact version schema
 */
export const artifactVersionSchema = z.object({
  id: z.string(), // SHA-256 content hash
  artifact_id: z.string(),
  size: z.number(), // Size in bytes
  file_count: z.number(),
  message: z.string().nullable(), // Optional commit message
  created_by: z.string(),
  created_at: timestampSchema,
});

export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

/**
 * Artifact detail schema (includes current version info)
 */
export const publicArtifactDetailSchema = publicArtifactSchema.extend({
  current_version: artifactVersionSchema.nullable(),
});

export type PublicArtifactDetail = z.infer<typeof publicArtifactDetailSchema>;

/**
 * Paginated artifacts response
 */
export const paginatedArtifactsSchema =
  createPaginatedResponseSchema(publicArtifactSchema);

/**
 * Paginated artifact versions response
 */
export const paginatedArtifactVersionsSchema = createPaginatedResponseSchema(
  artifactVersionSchema,
);

/**
 * Create artifact request schema
 */
export const createArtifactRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/,
      "Name must be lowercase alphanumeric with hyphens, not starting or ending with hyphen",
    ),
});

export type CreateArtifactRequest = z.infer<typeof createArtifactRequestSchema>;

/**
 * File entry for upload
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
 * Artifacts list contract - GET /v1/artifacts, POST /v1/artifacts
 */
export const publicArtifactsListContract = c.router({
  list: {
    method: "GET",
    path: "/v1/artifacts",
    query: listQuerySchema,
    responses: {
      200: paginatedArtifactsSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List artifacts",
    description: "List all artifacts in the current scope with pagination",
  },
  create: {
    method: "POST",
    path: "/v1/artifacts",
    body: createArtifactRequestSchema,
    responses: {
      201: publicArtifactDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      409: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Create artifact",
    description: "Create a new empty artifact container",
  },
});

/**
 * Artifact by ID contract - GET /v1/artifacts/:id
 */
export const publicArtifactByIdContract = c.router({
  get: {
    method: "GET",
    path: "/v1/artifacts/:id",
    pathParams: z.object({
      id: z.string().min(1, "Artifact ID is required"),
    }),
    responses: {
      200: publicArtifactDetailSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get artifact",
    description: "Get artifact details by ID",
  },
});

/**
 * Artifact versions contract - GET /v1/artifacts/:id/versions
 */
export const publicArtifactVersionsContract = c.router({
  list: {
    method: "GET",
    path: "/v1/artifacts/:id/versions",
    pathParams: z.object({
      id: z.string().min(1, "Artifact ID is required"),
    }),
    query: listQuerySchema,
    responses: {
      200: paginatedArtifactVersionsSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List artifact versions",
    description: "List all versions of an artifact with pagination",
  },
});

/**
 * Artifact upload contract - POST /v1/artifacts/:id/upload
 */
export const publicArtifactUploadContract = c.router({
  prepareUpload: {
    method: "POST",
    path: "/v1/artifacts/:id/upload",
    pathParams: z.object({
      id: z.string().min(1, "Artifact ID is required"),
    }),
    body: prepareUploadRequestSchema,
    responses: {
      200: prepareUploadResponseSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Prepare artifact upload",
    description:
      "Get presigned URLs for direct S3 upload. Returns upload URLs for each file.",
  },
});

/**
 * Artifact commit contract - POST /v1/artifacts/:id/commit
 */
export const publicArtifactCommitContract = c.router({
  commitUpload: {
    method: "POST",
    path: "/v1/artifacts/:id/commit",
    pathParams: z.object({
      id: z.string().min(1, "Artifact ID is required"),
    }),
    body: commitUploadRequestSchema,
    responses: {
      200: artifactVersionSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Commit artifact upload",
    description:
      "Finalize an upload session and create a new artifact version.",
  },
});

/**
 * Artifact download contract - GET /v1/artifacts/:id/download
 */
export const publicArtifactDownloadContract = c.router({
  download: {
    method: "GET",
    path: "/v1/artifacts/:id/download",
    pathParams: z.object({
      id: z.string().min(1, "Artifact ID is required"),
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
    summary: "Download artifact",
    description:
      "Get presigned URLs for downloading artifact files. Defaults to current version.",
  },
});

export type PublicArtifactsListContract = typeof publicArtifactsListContract;
export type PublicArtifactByIdContract = typeof publicArtifactByIdContract;
export type PublicArtifactVersionsContract =
  typeof publicArtifactVersionsContract;
export type PublicArtifactUploadContract = typeof publicArtifactUploadContract;
export type PublicArtifactCommitContract = typeof publicArtifactCommitContract;
export type PublicArtifactDownloadContract =
  typeof publicArtifactDownloadContract;
