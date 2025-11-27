import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/agent/runs/continue
 *
 * @deprecated Use POST /api/agent/runs with { sessionId, prompt } instead.
 * This endpoint redirects to the unified runs API.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();

  // Transform old format to unified format
  const unifiedBody = {
    sessionId: body.agentSessionId,
    prompt: body.prompt,
    volumeVersions: body.volumeVersions,
  };

  // Forward to unified endpoint
  const baseUrl = request.nextUrl.origin;
  const response = await fetch(`${baseUrl}/api/agent/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: request.headers.get("Authorization") || "",
      "x-vercel-protection-bypass":
        request.headers.get("x-vercel-protection-bypass") || "",
    },
    body: JSON.stringify(unifiedBody),
  });

  const data = await response.json();

  return NextResponse.json(data, {
    status: response.status,
    headers: {
      "X-Deprecated": "true",
      "X-Deprecation-Notice":
        "This endpoint is deprecated. Use POST /api/agent/runs with { sessionId, prompt } instead.",
    },
  });
}
