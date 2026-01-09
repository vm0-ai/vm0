/**
 * Public API v1 Contracts
 *
 * This module exports all contracts for the developer-friendly public REST API.
 * The public API is designed for external consumption with:
 * - Developer-friendly naming (e.g., "agents" not "composes")
 * - Stripe-style error responses
 * - Cursor-based pagination
 * - Rate limiting headers
 * - Self-service API token management
 *
 * URL Structure:
 * - /v1/agents - Agent management
 * - /v1/runs - Run execution and monitoring
 * - /v1/artifacts - Artifact storage (planned)
 * - /v1/volumes - Volume storage (planned)
 * - /v1/tokens - API token management
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
  // Rate limiting
  rateLimitInfoSchema,
  type RateLimitInfo,
  // Common types
  requestIdSchema,
  timestampSchema,
  // Constants
  ID_PREFIXES,
  TOKEN_PREFIXES,
  API_SCOPES,
  apiScopeSchema,
  type ApiScope,
} from "./common";

// Agent contracts
export {
  // Schemas
  publicAgentSchema,
  publicAgentDetailSchema,
  agentVersionSchema,
  paginatedAgentsSchema,
  paginatedAgentVersionsSchema,
  createAgentRequestSchema,
  updateAgentRequestSchema,
  // Contracts
  publicAgentsListContract,
  publicAgentByIdContract,
  publicAgentVersionsContract,
  // Types
  type PublicAgent,
  type PublicAgentDetail,
  type AgentVersion,
  type CreateAgentRequest,
  type UpdateAgentRequest,
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

// Token contracts
export {
  // Schemas
  publicTokenSchema,
  tokenCreatedResponseSchema,
  paginatedTokensSchema,
  createTokenRequestSchema,
  // Contracts
  publicTokensListContract,
  publicTokenByIdContract,
  // Types
  type PublicToken,
  type TokenCreatedResponse,
  type CreateTokenRequest,
  type PublicTokensListContract,
  type PublicTokenByIdContract,
} from "./tokens";
