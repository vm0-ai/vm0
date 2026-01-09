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

/**
 * Get or generate request ID from headers
 *
 * If the client provides an X-Request-Id header, use it (for debugging).
 * Otherwise, generate a new one.
 */
export function getOrGenerateRequestId(requestHeaders: Headers): string {
  const clientRequestId = requestHeaders.get(REQUEST_ID_HEADER);

  // Only allow client-provided IDs that match our format
  if (clientRequestId?.startsWith("req_")) {
    return clientRequestId;
  }

  return generateRequestId();
}
