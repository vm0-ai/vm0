/**
 * Public API v1 - Combined Contract for OpenAPI Generation
 *
 * This module combines all public API contracts into a single contract
 * that can be used to generate the OpenAPI specification.
 */
import { z } from "zod";
import { initContract } from "../base";
import {
  publicApiErrorSchema,
  createPaginatedResponseSchema,
  listQuerySchema,
} from "./common";

// Import schemas from each domain
import {
  publicAgentSchema,
  publicAgentDetailSchema,
  agentVersionSchema,
  createAgentRequestSchema,
  updateAgentRequestSchema,
} from "./agents";
import {
  publicRunSchema,
  publicRunDetailSchema,
  createRunRequestSchema,
  runListQuerySchema,
  paginatedLogsSchema,
  logsQuerySchema,
  metricsResponseSchema,
} from "./runs";
import {
  publicArtifactSchema,
  publicArtifactDetailSchema,
  artifactVersionSchema,
  createArtifactRequestSchema,
  prepareUploadRequestSchema as artifactPrepareUploadRequestSchema,
  prepareUploadResponseSchema as artifactPrepareUploadResponseSchema,
  commitUploadRequestSchema as artifactCommitUploadRequestSchema,
  downloadResponseSchema as artifactDownloadResponseSchema,
} from "./artifacts";
import {
  publicVolumeSchema,
  publicVolumeDetailSchema,
  volumeVersionSchema,
  createVolumeRequestSchema,
  prepareUploadRequestSchema as volumePrepareUploadRequestSchema,
  prepareUploadResponseSchema as volumePrepareUploadResponseSchema,
  commitUploadRequestSchema as volumeCommitUploadRequestSchema,
  downloadResponseSchema as volumeDownloadResponseSchema,
} from "./volumes";

const c = initContract();

// Create paginated response schemas
const paginatedAgentsSchema = createPaginatedResponseSchema(publicAgentSchema);
const paginatedAgentVersionsSchema =
  createPaginatedResponseSchema(agentVersionSchema);
const paginatedRunsSchema = createPaginatedResponseSchema(publicRunSchema);
const paginatedArtifactsSchema =
  createPaginatedResponseSchema(publicArtifactSchema);
const paginatedArtifactVersionsSchema = createPaginatedResponseSchema(
  artifactVersionSchema,
);
const paginatedVolumesSchema =
  createPaginatedResponseSchema(publicVolumeSchema);
const paginatedVolumeVersionsSchema =
  createPaginatedResponseSchema(volumeVersionSchema);

/**
 * Combined Public API v1 Contract
 *
 * This is the unified contract containing all endpoints for the public API.
 * Used for OpenAPI specification generation.
 *
 * NOTE: Each endpoint has a unique operation ID to avoid conflicts.
 */
export const publicApiContract = c.router({
  // ============= Agents =============
  listAgents: {
    method: "GET",
    path: "/v1/agents",
    query: listQuerySchema,
    responses: {
      200: paginatedAgentsSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List agents",
    description: "List all agents in the current scope with pagination",
  },
  createAgent: {
    method: "POST",
    path: "/v1/agents",
    body: createAgentRequestSchema,
    responses: {
      201: publicAgentDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      409: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Create agent",
    description: "Create a new agent with the given configuration",
  },
  getAgent: {
    method: "GET",
    path: "/v1/agents/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: publicAgentDetailSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get agent",
    description: "Get agent details by ID",
  },
  updateAgent: {
    method: "PUT",
    path: "/v1/agents/:id",
    pathParams: z.object({ id: z.string() }),
    body: updateAgentRequestSchema,
    responses: {
      200: publicAgentDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Update agent",
    description:
      "Update agent configuration. Creates a new version if config changes.",
  },
  deleteAgent: {
    method: "DELETE",
    path: "/v1/agents/:id",
    pathParams: z.object({ id: z.string() }),
    body: z.undefined(),
    responses: {
      204: z.undefined(),
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Delete agent",
    description: "Archive an agent (soft delete)",
  },
  listAgentVersions: {
    method: "GET",
    path: "/v1/agents/:id/versions",
    pathParams: z.object({ id: z.string() }),
    query: listQuerySchema,
    responses: {
      200: paginatedAgentVersionsSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List agent versions",
    description: "List all versions of an agent with pagination",
  },

  // ============= Runs =============
  listRuns: {
    method: "GET",
    path: "/v1/runs",
    query: runListQuerySchema,
    responses: {
      200: paginatedRunsSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List runs",
    description: "List all runs with optional filtering and pagination",
  },
  createRun: {
    method: "POST",
    path: "/v1/runs",
    body: createRunRequestSchema,
    responses: {
      202: publicRunDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Create run",
    description: "Create a new run to execute an agent",
  },
  getRun: {
    method: "GET",
    path: "/v1/runs/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: publicRunDetailSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get run",
    description: "Get run details by ID",
  },
  cancelRun: {
    method: "POST",
    path: "/v1/runs/:id/cancel",
    pathParams: z.object({ id: z.string() }),
    body: z.undefined(),
    responses: {
      200: publicRunDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Cancel run",
    description: "Cancel a running or pending run",
  },
  getRunLogs: {
    method: "GET",
    path: "/v1/runs/:id/logs",
    pathParams: z.object({ id: z.string() }),
    query: logsQuerySchema,
    responses: {
      200: paginatedLogsSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get run logs",
    description: "Get unified logs for a run (agent, system, network)",
  },
  getRunMetrics: {
    method: "GET",
    path: "/v1/runs/:id/metrics",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: metricsResponseSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get run metrics",
    description: "Get resource metrics (CPU, memory, disk) for a run",
  },

  // ============= Artifacts =============
  listArtifacts: {
    method: "GET",
    path: "/v1/artifacts",
    query: listQuerySchema,
    responses: {
      200: paginatedArtifactsSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List artifacts",
    description: "List all artifacts with pagination",
  },
  createArtifact: {
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
    description: "Create a new artifact",
  },
  getArtifact: {
    method: "GET",
    path: "/v1/artifacts/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: publicArtifactDetailSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get artifact",
    description: "Get artifact details by ID",
  },
  deleteArtifact: {
    method: "DELETE",
    path: "/v1/artifacts/:id",
    pathParams: z.object({ id: z.string() }),
    body: z.undefined(),
    responses: {
      204: z.undefined(),
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Delete artifact",
    description: "Delete an artifact",
  },
  listArtifactVersions: {
    method: "GET",
    path: "/v1/artifacts/:id/versions",
    pathParams: z.object({ id: z.string() }),
    query: listQuerySchema,
    responses: {
      200: paginatedArtifactVersionsSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List artifact versions",
    description: "List all versions of an artifact",
  },
  prepareArtifactUpload: {
    method: "POST",
    path: "/v1/artifacts/:id/upload",
    pathParams: z.object({ id: z.string() }),
    body: artifactPrepareUploadRequestSchema,
    responses: {
      200: artifactPrepareUploadResponseSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Prepare artifact upload",
    description: "Get presigned URLs for uploading artifact files",
  },
  commitArtifactUpload: {
    method: "POST",
    path: "/v1/artifacts/:id/commit",
    pathParams: z.object({ id: z.string() }),
    body: artifactCommitUploadRequestSchema,
    responses: {
      200: publicArtifactDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Commit artifact upload",
    description: "Commit uploaded files to create a new artifact version",
  },
  downloadArtifact: {
    method: "GET",
    path: "/v1/artifacts/:id/download",
    pathParams: z.object({ id: z.string() }),
    query: z.object({ version: z.string().optional() }),
    responses: {
      200: artifactDownloadResponseSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Download artifact",
    description: "Get presigned URL for downloading artifact",
  },

  // ============= Volumes =============
  listVolumes: {
    method: "GET",
    path: "/v1/volumes",
    query: listQuerySchema,
    responses: {
      200: paginatedVolumesSchema,
      401: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List volumes",
    description: "List all volumes with pagination",
  },
  createVolume: {
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
    description: "Create a new volume",
  },
  getVolume: {
    method: "GET",
    path: "/v1/volumes/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: publicVolumeDetailSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Get volume",
    description: "Get volume details by ID",
  },
  deleteVolume: {
    method: "DELETE",
    path: "/v1/volumes/:id",
    pathParams: z.object({ id: z.string() }),
    body: z.undefined(),
    responses: {
      204: z.undefined(),
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Delete volume",
    description: "Delete a volume",
  },
  listVolumeVersions: {
    method: "GET",
    path: "/v1/volumes/:id/versions",
    pathParams: z.object({ id: z.string() }),
    query: listQuerySchema,
    responses: {
      200: paginatedVolumeVersionsSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "List volume versions",
    description: "List all versions of a volume",
  },
  prepareVolumeUpload: {
    method: "POST",
    path: "/v1/volumes/:id/upload",
    pathParams: z.object({ id: z.string() }),
    body: volumePrepareUploadRequestSchema,
    responses: {
      200: volumePrepareUploadResponseSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Prepare volume upload",
    description: "Get presigned URLs for uploading volume files",
  },
  commitVolumeUpload: {
    method: "POST",
    path: "/v1/volumes/:id/commit",
    pathParams: z.object({ id: z.string() }),
    body: volumeCommitUploadRequestSchema,
    responses: {
      200: publicVolumeDetailSchema,
      400: publicApiErrorSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Commit volume upload",
    description: "Commit uploaded files to create a new volume version",
  },
  downloadVolume: {
    method: "GET",
    path: "/v1/volumes/:id/download",
    pathParams: z.object({ id: z.string() }),
    query: z.object({ version: z.string().optional() }),
    responses: {
      200: volumeDownloadResponseSchema,
      401: publicApiErrorSchema,
      404: publicApiErrorSchema,
      500: publicApiErrorSchema,
    },
    summary: "Download volume",
    description: "Get presigned URL for downloading volume",
  },
});

export type PublicApiContract = typeof publicApiContract;
