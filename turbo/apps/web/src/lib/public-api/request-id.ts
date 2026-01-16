/**
 * Public API v1 Request ID
 *
 * Generates and manages request IDs for tracing and debugging.
 */
import { randomUUID } from "crypto";

/**
 * Request ID header name
 */
export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Generate a new request ID
 */
export function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "")}`;
}
