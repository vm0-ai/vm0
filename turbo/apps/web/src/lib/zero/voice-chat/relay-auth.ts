import "server-only";
import { NextResponse } from "next/server";
import { verifyRelayToken } from "@vm0/core/voice-chat/relay-token";
import { env } from "../../../env";

interface RelayAuthContext {
  userId: string;
  orgId: string;
  voiceChatSessionId: string;
}

/**
 * Resolve the relay-token authentication context for an internal voice-chat
 * relay route. The token is presented as `Authorization: Bearer <token>` and
 * verified against the shared HMAC secret. The token's `voiceChatSessionId`
 * claim must match the path's `id`, and `orgId` must be present (the relay
 * bootstrap admission route in #12140 always issues tokens with orgId).
 * Returns the validated context or a pre-built error Response.
 *
 * The verifier is the canonical helper from #12140 in @vm0/core; this wrapper
 * adapts it to the Next.js Response shape used by `_support.ts`. Three sites
 * verify the same token (apps/api WS upgrade, the internal /items route, the
 * internal /tasks route), all going through `@vm0/core/voice-chat/relay-token`.
 */
export function resolveRelayAuth(
  request: Request,
  expectedSessionId: string,
): RelayAuthContext | Response {
  const secret = env().VOICE_CHAT_RELAY_TOKEN_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error: {
          message: "Voice-chat relay token secret not configured",
          code: "SERVICE_UNAVAILABLE",
        },
      },
      { status: 503 },
    );
  }

  const authHeader = request.headers.get("authorization");
  const token = parseBearerToken(authHeader);
  if (!token) {
    return NextResponse.json(
      { error: { message: "Missing relay token", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const result = verifyRelayToken(token, secret);
  if (!result.ok) {
    return NextResponse.json(
      { error: { message: "Invalid relay token", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  if (result.claims.voiceChatSessionId !== expectedSessionId) {
    return NextResponse.json(
      { error: { message: "Invalid relay token", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  if (!result.claims.orgId) {
    return NextResponse.json(
      { error: { message: "Invalid relay token", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  return {
    userId: result.claims.userId,
    orgId: result.claims.orgId,
    voiceChatSessionId: result.claims.voiceChatSessionId,
  };
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return null;
  const token = authHeader.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}
