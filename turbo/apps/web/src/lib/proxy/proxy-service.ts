import { logger } from "../logger";
import { isProxyToken, extractSecretFromToken } from "./token-service";

const log = logger("proxy");

/**
 * Headers that should not be forwarded to the target
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/**
 * Headers that should not be forwarded back from the target
 */
const RESPONSE_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export interface ProxyResult {
  response: Response;
  targetUrl: string;
}

export interface ProxyError {
  error: {
    message: string;
    code: string;
    targetUrl?: string;
  };
}

/**
 * Forward a request to a target URL
 *
 * @param request - The incoming request
 * @param targetUrl - The target URL to forward to
 * @param runId - Optional run ID for proxy token validation
 * @returns The proxied response
 */
export async function forwardRequest(
  request: Request,
  targetUrl: string,
  runId?: string,
): Promise<ProxyResult> {
  log.debug(`Forwarding request to ${targetUrl}`);

  // Build headers to forward (excluding hop-by-hop headers)
  const forwardHeaders = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  });

  // Check and decrypt proxy token in Authorization header
  const authHeader = forwardHeaders.get("authorization");
  if (authHeader) {
    // Extract token from "Bearer <token>" format or raw token
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    if (isProxyToken(token)) {
      log.debug("Detected proxy token in Authorization header, decrypting");
      const secret = extractSecretFromToken(token, runId);

      if (secret) {
        // Replace with decrypted secret in same format
        const newAuthHeader = authHeader.startsWith("Bearer ")
          ? `Bearer ${secret}`
          : secret;
        forwardHeaders.set("authorization", newAuthHeader);
        log.debug("Successfully decrypted proxy token");
      } else {
        log.warn("Failed to decrypt proxy token - token invalid or expired");
        // Keep original header if decryption fails (will likely fail at target)
      }
    }
  }

  // Also check x-api-key header for proxy tokens
  const apiKeyHeader = forwardHeaders.get("x-api-key");
  if (apiKeyHeader && isProxyToken(apiKeyHeader)) {
    log.debug("Detected proxy token in x-api-key header, decrypting");
    const secret = extractSecretFromToken(apiKeyHeader, runId);

    if (secret) {
      forwardHeaders.set("x-api-key", secret);
      log.debug("Successfully decrypted x-api-key proxy token");
    } else {
      log.warn(
        "Failed to decrypt x-api-key proxy token - token invalid or expired",
      );
    }
  }

  // Get request body
  const body = await request.arrayBuffer();

  // Make request to target
  const targetResponse = await fetch(targetUrl, {
    method: request.method,
    headers: forwardHeaders,
    body: body.byteLength > 0 ? body : undefined,
  });

  log.debug(
    `Target responded with status ${targetResponse.status} for ${targetUrl}`,
  );

  // Build response headers (excluding hop-by-hop headers)
  const responseHeaders = new Headers();
  targetResponse.headers.forEach((value, key) => {
    if (!RESPONSE_HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  // Check if this is a streaming response (SSE)
  const contentType = targetResponse.headers.get("content-type") || "";
  const isStreaming = contentType.includes("text/event-stream");

  if (isStreaming && targetResponse.body) {
    // For SSE, stream the response directly
    log.debug(`Streaming SSE response from ${targetUrl}`);
    return {
      response: new Response(targetResponse.body, {
        status: targetResponse.status,
        statusText: targetResponse.statusText,
        headers: responseHeaders,
      }),
      targetUrl,
    };
  }

  // For non-streaming responses, pass through the body
  return {
    response: new Response(targetResponse.body, {
      status: targetResponse.status,
      statusText: targetResponse.statusText,
      headers: responseHeaders,
    }),
    targetUrl,
  };
}

/**
 * Validate and decode a target URL from query parameter
 *
 * @param encodedUrl - The URL-encoded target URL
 * @returns The decoded URL or null if invalid
 */
export function decodeTargetUrl(encodedUrl: string | null): string | null {
  if (!encodedUrl) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(encodedUrl);

    // Validate it's a proper URL
    const url = new URL(decoded);

    // Only allow http and https protocols
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      log.warn(`Invalid protocol in target URL: ${url.protocol}`);
      return null;
    }

    return decoded;
  } catch {
    log.warn(`Failed to decode target URL: ${encodedUrl}`);
    return null;
  }
}
