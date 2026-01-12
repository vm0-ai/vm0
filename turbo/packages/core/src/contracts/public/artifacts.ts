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
 * Artifacts list contract - GET /v1/artifacts
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
 * Artifact download contract - GET /v1/artifacts/:id/download
 * Returns 302 redirect to presigned URL for archive.tar.gz
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
      302: z.undefined(), // Redirect to presigned URL
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Download artifact",
    description:
      "Redirect to presigned URL for downloading artifact as tar.gz archive. Defaults to current version.",
  },
});

export type PublicArtifactsListContract = typeof publicArtifactsListContract;
export type PublicArtifactByIdContract = typeof publicArtifactByIdContract;
export type PublicArtifactVersionsContract =
  typeof publicArtifactVersionsContract;
export type PublicArtifactDownloadContract =
  typeof publicArtifactDownloadContract;
