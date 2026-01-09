/**
 * Public API v1 Infrastructure
 *
 * This module provides the infrastructure for the developer-friendly public REST API:
 * - Request ID tracking
 * - Rate limiting
 * - Standardized error handling (Stripe-style)
 * - Handler creation utilities
 */

// Handler creation
export {
  createPublicApiHandler,
  createPublicApiContext,
  tsr,
  TsRestResponse,
  type PublicApiContext,
} from "./handler";

// Error handling
export {
  createPublicApiErrorResponse,
  invalidParameterError,
  missingParameterError,
  invalidApiKeyError,
  expiredApiKeyError,
  missingApiKeyError,
  insufficientScopeError,
  resourceNotFoundError,
  resourceAlreadyExistsError,
  rateLimitExceededError,
  internalServerError,
  publicApiErrorHandler,
  isPublicApiError,
} from "./errors";

// Rate limiting
export {
  checkRateLimit,
  getRateLimitInfo,
  setRateLimitHeaders,
  resetRateLimits,
  DEFAULT_RATE_LIMIT,
  READ_RATE_LIMIT,
  WRITE_RATE_LIMIT,
  RATE_LIMIT_HEADERS,
  type RateLimitConfig,
} from "./rate-limiter";

// Request ID
export {
  REQUEST_ID_HEADER,
  generateRequestId,
  getOrGenerateRequestId,
} from "./request-id";

// Authentication
export {
  authenticatePublicApi,
  isAuthSuccess,
  type PublicApiAuth,
} from "./auth";
