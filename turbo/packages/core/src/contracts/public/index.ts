/**
 * Public API v1 Contracts
 *
 * This module exports all contracts for the developer-friendly public REST API.
 * The public API is designed for external consumption with:
 * - Developer-friendly naming (e.g., "agents" not "composes")
 * - Stripe-style error responses
 * - Cursor-based pagination
 *
 * URL Structure:
 * - /v1/agents - Agent management
 * - /v1/runs - Run execution and monitoring
 * - /v1/artifacts - Artifact storage
 * - /v1/volumes - Volume storage
 */

// Common schemas and utilities
export {
  // Error handling
  publicApiErrorSchema,
  publicApiErrorTypeSchema,
  PublicApiErrorCode,
  createPublicApiError,
  errorTypeToStatus,
  type PublicApiError,
  type PublicApiErrorType,
  type PublicApiErrorCodeType,
  // Pagination
  paginationSchema,
  createPaginatedResponseSchema,
  listQuerySchema,
  type Pagination,
  type ListQuery,
  // Common types
  requestIdSchema,
  timestampSchema,
  // Constants
  ID_PREFIXES,
  TOKEN_PREFIXES,
} from "./common";

// Agent contracts
export {
  // Schemas
  publicAgentSchema,
  publicAgentDetailSchema,
  agentVersionSchema,
  paginatedAgentsSchema,
  paginatedAgentVersionsSchema,
  updateAgentRequestSchema,
  agentListQuerySchema,
  // Contracts
  publicAgentsListContract,
  publicAgentByIdContract,
  publicAgentVersionsContract,
  // Types
  type PublicAgent,
  type PublicAgentDetail,
  type AgentVersion,
  type UpdateAgentRequest,
  type AgentListQuery,
  type PublicAgentsListContract,
  type PublicAgentByIdContract,
  type PublicAgentVersionsContract,
} from "./agents";

// Run contracts
export {
  // Schemas
  publicRunSchema,
  publicRunDetailSchema,
  publicRunStatusSchema,
  paginatedRunsSchema,
  createRunRequestSchema,
  runListQuerySchema,
  logEntrySchema,
  paginatedLogsSchema,
  logsQuerySchema,
  metricPointSchema,
  metricsSummarySchema,
  metricsResponseSchema,
  sseEventTypeSchema,
  sseEventSchema,
  // Contracts
  publicRunsListContract,
  publicRunByIdContract,
  publicRunCancelContract,
  publicRunLogsContract,
  publicRunMetricsContract,
  publicRunEventsContract,
  // Types
  type PublicRun,
  type PublicRunDetail,
  type PublicRunStatus,
  type CreateRunRequest,
  type RunListQuery,
  type LogEntry,
  type LogsQuery,
  type MetricPoint,
  type MetricsSummary,
  type MetricsResponse,
  type SSEEventType,
  type SSEEvent,
  type PublicRunsListContract,
  type PublicRunByIdContract,
  type PublicRunCancelContract,
  type PublicRunLogsContract,
  type PublicRunMetricsContract,
  type PublicRunEventsContract,
} from "./runs";

// Artifact contracts
export {
  // Schemas
  publicArtifactSchema,
  publicArtifactDetailSchema,
  artifactVersionSchema,
  paginatedArtifactsSchema,
  paginatedArtifactVersionsSchema,
  createArtifactRequestSchema,
  prepareUploadRequestSchema as artifactPrepareUploadRequestSchema,
  prepareUploadResponseSchema as artifactPrepareUploadResponseSchema,
  commitUploadRequestSchema as artifactCommitUploadRequestSchema,
  downloadResponseSchema as artifactDownloadResponseSchema,
  fileEntrySchema as artifactFileEntrySchema,
  presignedUploadSchema as artifactPresignedUploadSchema,
  // Contracts
  publicArtifactsListContract,
  publicArtifactByIdContract,
  publicArtifactVersionsContract,
  publicArtifactUploadContract,
  publicArtifactCommitContract,
  publicArtifactDownloadContract,
  // Types
  type PublicArtifact,
  type PublicArtifactDetail,
  type ArtifactVersion,
  type CreateArtifactRequest,
  type PrepareUploadRequest as ArtifactPrepareUploadRequest,
  type PrepareUploadResponse as ArtifactPrepareUploadResponse,
  type CommitUploadRequest as ArtifactCommitUploadRequest,
  type DownloadResponse as ArtifactDownloadResponse,
  type FileEntry as ArtifactFileEntry,
  type PresignedUpload as ArtifactPresignedUpload,
  type PublicArtifactsListContract,
  type PublicArtifactByIdContract,
  type PublicArtifactVersionsContract,
  type PublicArtifactUploadContract,
  type PublicArtifactCommitContract,
  type PublicArtifactDownloadContract,
} from "./artifacts";

// Volume contracts
export {
  // Schemas
  publicVolumeSchema,
  publicVolumeDetailSchema,
  volumeVersionSchema,
  paginatedVolumesSchema,
  paginatedVolumeVersionsSchema,
  createVolumeRequestSchema,
  prepareUploadRequestSchema as volumePrepareUploadRequestSchema,
  prepareUploadResponseSchema as volumePrepareUploadResponseSchema,
  commitUploadRequestSchema as volumeCommitUploadRequestSchema,
  downloadResponseSchema as volumeDownloadResponseSchema,
  fileEntrySchema as volumeFileEntrySchema,
  presignedUploadSchema as volumePresignedUploadSchema,
  // Contracts
  publicVolumesListContract,
  publicVolumeByIdContract,
  publicVolumeVersionsContract,
  publicVolumeUploadContract,
  publicVolumeCommitContract,
  publicVolumeDownloadContract,
  // Types
  type PublicVolume,
  type PublicVolumeDetail,
  type VolumeVersion,
  type CreateVolumeRequest,
  type PrepareUploadRequest as VolumePrepareUploadRequest,
  type PrepareUploadResponse as VolumePrepareUploadResponse,
  type CommitUploadRequest as VolumeCommitUploadRequest,
  type DownloadResponse as VolumeDownloadResponse,
  type FileEntry as VolumeFileEntry,
  type PresignedUpload as VolumePresignedUpload,
  type PublicVolumesListContract,
  type PublicVolumeByIdContract,
  type PublicVolumeVersionsContract,
  type PublicVolumeUploadContract,
  type PublicVolumeCommitContract,
  type PublicVolumeDownloadContract,
} from "./volumes";

// Token contracts
export {
  // Schemas
  publicTokenSchema,
  publicTokenDetailSchema,
  paginatedTokensSchema,
  createTokenRequestSchema,
  // Contracts
  publicTokensListContract,
  publicTokenByIdContract,
  // Types
  type PublicToken,
  type PublicTokenDetail,
  type CreateTokenRequest,
  type PublicTokensListContract,
  type PublicTokenByIdContract,
} from "./tokens";
