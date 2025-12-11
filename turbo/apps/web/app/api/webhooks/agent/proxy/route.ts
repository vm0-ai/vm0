import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  forwardRequest,
  decodeTargetUrl,
} from "../../../../../src/lib/proxy/proxy-service";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhook:proxy");

/**
 * POST /api/webhooks/agent/proxy?url=<encoded_target_url>
 *
 * Generic proxy endpoint for sandbox requests.
 * Validates sandbox token, decodes target URL, and forwards the request.
 * Supports SSE streaming responses.
 */
export async function POST(request: Request) {
  initServices();

  // 1. Authenticate via sandbox token
  const userId = await getUserId();
  if (!userId) {
    log.warn("Proxy request without valid authentication");
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  // 2. Extract and validate target URL from query param
  const { searchParams } = new URL(request.url);
  const encodedUrl = searchParams.get("url");

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

  log.debug(`Proxying request for user ${userId} to ${targetUrl}`);

  // 3. Forward request to target
  try {
    const result = await forwardRequest(request, targetUrl);
    return result.response;
  } catch (err) {
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
