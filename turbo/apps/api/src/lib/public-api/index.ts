/**
 * Public API v1 Infrastructure
 *
 * This module provides the infrastructure for the developer-friendly public REST API:
 * - Request ID tracking
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
  resourceNotFoundError,
  resourceAlreadyExistsError,
  internalServerError,
  publicApiErrorHandler,
  isPublicApiError,
} from "./errors";

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
