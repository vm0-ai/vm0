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
  // Authorization header from mitmproxy contains sandbox token for VM0 Proxy auth
  // We'll restore the original Authorization from x-vm0-original-authorization
  "authorization",
  // Internal header used by mitmproxy to preserve original Authorization
  "x-vm0-original-authorization",
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

interface ProxyResult {
  response: Response;
  targetUrl: string;
}

/**
 * Error thrown when proxy token decryption fails
 */
export class ProxyTokenDecryptionError extends Error {
  constructor(
    message: string,
    public readonly header: string,
  ) {
    super(message);
    this.name = "ProxyTokenDecryptionError";
  }
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

  // Restore original Authorization header from x-vm0-original-authorization
  // mitmproxy saves the original header there before overwriting with sandbox token
  const originalAuthHeader = request.headers.get(
    "x-vm0-original-authorization",
  );
  if (originalAuthHeader) {
    // Extract token from "Bearer <token>" format or raw token
    const token = originalAuthHeader.startsWith("Bearer ")
      ? originalAuthHeader.slice(7)
      : originalAuthHeader;

    if (isProxyToken(token)) {
      log.debug(
        "Detected proxy token in original Authorization header, decrypting",
      );
      const secret = extractSecretFromToken(token, runId);

      if (secret) {
        // Replace with decrypted secret in same format
        const newAuthHeader = originalAuthHeader.startsWith("Bearer ")
          ? `Bearer ${secret}`
          : secret;
        forwardHeaders.set("authorization", newAuthHeader);
        log.debug("Successfully decrypted Authorization proxy token");
      } else {
        log.warn(
          "Failed to decrypt Authorization proxy token - token invalid or expired",
        );
        throw new ProxyTokenDecryptionError(
          "Proxy token decryption failed - token may be invalid or expired",
          "Authorization",
        );
      }
    } else {
      // Not a proxy token, restore original value as-is
      forwardHeaders.set("authorization", originalAuthHeader);
      log.debug("Restored original Authorization header (no proxy token)");
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
      throw new ProxyTokenDecryptionError(
        "Proxy token decryption failed - token may be invalid or expired",
        "x-api-key",
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

  // Log SSE streaming for debugging
  const contentType = targetResponse.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    log.debug(`Streaming SSE response from ${targetUrl}`);
  }

  // Return response (works for both streaming and non-streaming)
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
 * Check if a hostname is a private/internal address (SSRF protection)
 *
 * Blocks:
 * - localhost, 127.0.0.1, ::1 (loopback)
 * - 169.254.169.254 (cloud metadata services - AWS, GCP, Azure)
 * - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC 1918 private)
 * - 169.254.0.0/16 (link-local)
 * - 0.0.0.0 (can resolve to localhost)
 * - [::], [::1] (IPv6 loopback)
 * - Internal hostnames
 */
// eslint-disable-next-line complexity -- TODO: refactor complex function
function isPrivateOrInternalHost(hostname: string): boolean {
  // Normalize hostname (remove brackets for IPv6)
  const normalizedHost = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Block localhost and common aliases
  if (
    normalizedHost === "localhost" ||
    normalizedHost === "localhost.localdomain" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local")
  ) {
    return true;
  }

  // Block cloud metadata service IPs
  // AWS: 169.254.169.254, fd00:ec2::254
  // GCP: metadata.google.internal, 169.254.169.254
  // Azure: 169.254.169.254
  if (
    normalizedHost === "169.254.169.254" ||
    normalizedHost === "metadata.google.internal" ||
    normalizedHost.startsWith("fd00:ec2")
  ) {
    return true;
  }

  // Block internal kubernetes/docker hostnames
  if (
    normalizedHost.endsWith(".internal") ||
    normalizedHost.endsWith(".svc.cluster.local") ||
    normalizedHost === "kubernetes" ||
    normalizedHost === "kubernetes.default"
  ) {
    return true;
  }

  // Parse IP address to check for private ranges
  // IPv4 check
  const ipv4Match = normalizedHost.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);

    // 0.0.0.0 - can resolve to localhost
    if (a === 0 && b === 0 && c === 0 && d === 0) return true;

    // 127.0.0.0/8 - loopback
    if (a === 127) return true;

    // 10.0.0.0/8 - private
    if (a === 10) return true;

    // 172.16.0.0/12 - private (172.16.0.0 - 172.31.255.255)
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16 - private
    if (a === 192 && b === 168) return true;

    // 169.254.0.0/16 - link-local
    if (a === 169 && b === 254) return true;

    // 100.64.0.0/10 - Carrier-grade NAT (100.64.0.0 - 100.127.255.255)
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  }

  // IPv6 loopback and private ranges
  if (
    normalizedHost === "::" ||
    normalizedHost === "::1" ||
    normalizedHost.startsWith("fc") || // fc00::/7 - unique local
    normalizedHost.startsWith("fd") || // fd00::/8 - unique local
    normalizedHost.startsWith("fe80") // fe80::/10 - link-local
  ) {
    return true;
  }

  return false;
}

/**
 * Validate and decode a target URL from query parameter
 * Includes SSRF protection to block private/internal addresses
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

    // SSRF protection: block private/internal addresses
    if (isPrivateOrInternalHost(url.hostname)) {
      log.warn(`Blocked SSRF attempt to internal address: ${url.hostname}`);
      return null;
    }

    return decoded;
  } catch {
    log.warn(`Failed to decode target URL: ${encodedUrl}`);
    return null;
  }
}
