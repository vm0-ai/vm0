import { z } from "zod";

/**
 * Proxy endpoint types for /api/webhooks/agent/proxy
 *
 * This endpoint acts as a generic HTTP proxy for sandbox requests.
 * It validates the sandbox token, extracts the target URL from query params,
 * and forwards the request with full body/header passthrough.
 *
 * Note: This endpoint doesn't use ts-rest router because it needs to:
 * - Handle raw request/response streaming (SSE support)
 * - Pass through request body without validation
 * - Stream response back directly
 *
 * API Design:
 * POST /api/webhooks/agent/proxy?url=<encoded_target_url>
 *
 * Headers:
 *   Authorization: Bearer vm0_live_xxx (sandbox token)
 *   Content-Type: (passthrough)
 *
 * Body: (passthrough to target)
 * Response: (passthrough from target, supports SSE streaming)
 */

/**
 * Proxy error response schema
 */
export const proxyErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.enum([
      "UNAUTHORIZED",
      "BAD_REQUEST",
      "BAD_GATEWAY",
      "INTERNAL_ERROR",
    ]),
    targetUrl: z.string().optional(),
  }),
});

export type ProxyError = z.infer<typeof proxyErrorSchema>;

/**
 * Proxy error codes
 */
export const ProxyErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  BAD_REQUEST: "BAD_REQUEST",
  BAD_GATEWAY: "BAD_GATEWAY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ProxyErrorCode =
  (typeof ProxyErrorCode)[keyof typeof ProxyErrorCode];
