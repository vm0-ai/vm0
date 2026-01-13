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
  agentListQuerySchema,
  // Contracts
  publicAgentsListContract,
  publicAgentByIdContract,
  publicAgentVersionsContract,
  // Types
  type PublicAgent,
  type PublicAgentDetail,
  type AgentVersion,
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
  // Contracts
  publicArtifactsListContract,
  publicArtifactByIdContract,
  publicArtifactVersionsContract,
  publicArtifactDownloadContract,
  // Types
  type PublicArtifact,
  type PublicArtifactDetail,
  type ArtifactVersion,
  type PublicArtifactsListContract,
  type PublicArtifactByIdContract,
  type PublicArtifactVersionsContract,
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
  // Contracts
  publicVolumesListContract,
  publicVolumeByIdContract,
  publicVolumeVersionsContract,
  publicVolumeDownloadContract,
  // Types
  type PublicVolume,
  type PublicVolumeDetail,
  type VolumeVersion,
  type PublicVolumesListContract,
  type PublicVolumeByIdContract,
  type PublicVolumeVersionsContract,
  type PublicVolumeDownloadContract,
} from "./volumes";
