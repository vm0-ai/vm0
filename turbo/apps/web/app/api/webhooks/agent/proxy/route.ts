import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import {
  forwardRequest,
  decodeTargetUrl,
  ProxyTokenDecryptionError,
} from "../../../../../src/lib/proxy/proxy-service";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhook:proxy");

/**
 * /api/webhooks/agent/proxy?url=<encoded_target_url>&runId=<run_id>
 *
 * Generic proxy endpoint for sandbox requests.
 * Validates sandbox JWT token and verifies runId matches, then forwards the request.
 * Supports SSE streaming responses.
 *
 * NOTE: All HTTP methods are supported because mitmproxy preserves the original
 * request method when forwarding through this proxy.
 */
async function handleProxyRequest(request: Request) {
  initServices();

  // 1. Extract runId from query params first (needed for JWT validation)
  const { searchParams } = new URL(request.url);
  const encodedUrl = searchParams.get("url");
  const runId = searchParams.get("runId");

  // runId is required to prevent token replay attacks across runs
  // mitmproxy addon always includes runId in requests
  if (!runId) {
    log.warn("Proxy request without runId parameter");
    return NextResponse.json(
      {
        error: {
          message: "runId parameter is required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // 2. Authenticate via sandbox JWT and verify runId matches
  const auth = getSandboxAuthForRun(
    runId,
    request.headers.get("Authorization") ?? undefined,
  );
  if (!auth) {
    log.warn("Proxy request without valid authentication or runId mismatch");
    return NextResponse.json(
      {
        error: {
          message: "Not authenticated or runId mismatch",
          code: "UNAUTHORIZED",
        },
      },
      { status: 401 },
    );
  }

  const { userId } = auth;

  const targetUrl = decodeTargetUrl(encodedUrl);
  if (!targetUrl) {
    log.warn(`Invalid or missing target URL: ${encodedUrl}`);
    return NextResponse.json(
      {
        error: {
          message: "Missing or invalid url parameter",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  log.debug(
    `Proxying request for user ${userId} to ${targetUrl} (runId: ${runId})`,
  );

  // 3. Forward request to target (handles proxy token decryption)
  try {
    const result = await forwardRequest(request, targetUrl, runId);
    return result.response;
  } catch (err) {
    // Handle proxy token decryption errors specifically
    if (err instanceof ProxyTokenDecryptionError) {
      log.warn(`Token decryption failed for ${targetUrl}: ${err.message}`);
      return NextResponse.json(
        {
          error: {
            message: err.message,
            code: "UNAUTHORIZED",
            header: err.header,
          },
        },
        { status: 401 },
      );
    }

    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`Proxy request failed for ${targetUrl}: ${message}`);

    return NextResponse.json(
      {
        error: {
          message: `Failed to reach target: ${message}`,
          code: "BAD_GATEWAY",
          targetUrl,
        },
      },
      { status: 502 },
    );
  }
}

// Export handler for all HTTP methods that might be proxied
// mitmproxy preserves the original request method when forwarding
export {
  handleProxyRequest as GET,
  handleProxyRequest as POST,
  handleProxyRequest as PUT,
  handleProxyRequest as DELETE,
  handleProxyRequest as PATCH,
  handleProxyRequest as OPTIONS,
  handleProxyRequest as HEAD,
};
