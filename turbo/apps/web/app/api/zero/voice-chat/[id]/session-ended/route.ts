import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { isApiError } from "@vm0/api-services/errors";
import { voiceChatRealtimeSessions } from "@vm0/db/schema/voice-chat";

import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  badRequestResponse,
  notFoundResponse,
  unauthorizedResponse,
} from "../../_support";

const sessionEndedBodySchema = z.object({
  relaySessionId: z.uuid(),
});

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  // No Trinity / billing gate here: a terminal status update is best-effort
  // audit. Even after a flip-back the browser should be able to mark its
  // row "ended" so an oncall query for "active relay sessions older than
  // 1h" doesn't return stale rows.
  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return unauthorizedResponse();

  const parsed = sessionEndedBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  const { id } = await params;
  const db = globalThis.services.db;

  // Ownership is verified against the relay row itself — confirms the
  // caller owns the row regardless of whether the underlying voice-chat
  // session is still accessible.
  const found = await db
    .select({
      id: voiceChatRealtimeSessions.id,
      orgId: voiceChatRealtimeSessions.orgId,
      userId: voiceChatRealtimeSessions.userId,
      voiceChatSessionId: voiceChatRealtimeSessions.voiceChatSessionId,
    })
    .from(voiceChatRealtimeSessions)
    .where(eq(voiceChatRealtimeSessions.id, parsed.data.relaySessionId))
    .limit(1);
  const row = found[0];
  if (
    !row ||
    row.voiceChatSessionId !== id ||
    row.orgId !== authCtx.orgId ||
    row.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat realtime session not found");
  }

  // Idempotent: re-calls or stale calls (status already "ended" or "error")
  // are zero-row UPDATEs and return 200.
  await db
    .update(voiceChatRealtimeSessions)
    .set({ status: "ended", endedAt: new Date() })
    .where(
      and(
        eq(voiceChatRealtimeSessions.id, parsed.data.relaySessionId),
        eq(voiceChatRealtimeSessions.status, "active"),
      ),
    );

  return NextResponse.json({ ok: true as const });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    return await handlePost(request, context);
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    throw error;
  }
}
