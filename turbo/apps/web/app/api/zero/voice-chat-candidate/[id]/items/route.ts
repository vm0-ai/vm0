import { NextResponse, after } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import { getVoiceChatCandidateSession } from "../../../../../../src/lib/zero/voice-chat-candidate/session-service";
import { appendVoiceChatCandidateItem } from "../../../../../../src/lib/zero/voice-chat-candidate/item-service";
import { triggerReasoning } from "../../../../../../src/lib/zero/voice-chat-candidate/trigger-reasoning";
import { voiceChatItems } from "../../../../../../src/db/schema/voice-chat";
import { isBadRequest } from "../../../../../../src/lib/shared/errors";
import {
  appendVoiceChatCandidateItemBodySchema,
  badRequestResponse,
  isVoiceChatCandidateEnabled,
  notFoundResponse,
  serializeVoiceChatCandidateItem,
  unauthorizedResponse,
} from "../../_support";

export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

  // See [id]/route.ts for why this is 404 (not 403) on flag-off.
  if (!(await isVoiceChatCandidateEnabled(authCtx))) {
    return notFoundResponse("Voice-chat-candidate session not found");
  }

  const { id } = await params;
  const session = await getVoiceChatCandidateSession(id);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat-candidate session not found");
  }

  const parsed = appendVoiceChatCandidateItemBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  try {
    const inserted = await appendVoiceChatCandidateItem({
      sessionId: id,
      role: parsed.data.role,
      content: parsed.data.content,
      realtimeItemId: parsed.data.realtimeItemId,
    });

    if (inserted) {
      // Fresh insert — tick the reasoner asynchronously. The Trinity client
      // maintains its own `last user / assistant` in local state and does
      // not listen on the session Ably channel for transcript rows, so we
      // no longer publish here on a plain user/assistant append. Silent-
      // dedupe replays (null return, see below) skip the reasoner trigger
      // for idempotency.
      after(() => {
        return triggerReasoning(id);
      });
      return NextResponse.json({
        item: serializeVoiceChatCandidateItem(inserted),
      });
    }

    // Silent dedupe: the (sessionId, realtimeItemId) pair already exists.
    // Recover the existing row so the 200 response schema stays populated.
    const db = globalThis.services.db;
    const [existing] = await db
      .select()
      .from(voiceChatItems)
      .where(
        and(
          eq(voiceChatItems.sessionId, id),
          eq(voiceChatItems.realtimeItemId, parsed.data.realtimeItemId),
        ),
      )
      .limit(1);
    if (!existing) {
      // Extremely unlikely — the conflict target matched but the row
      // vanished between insert and SELECT. Treat as 404 so the caller
      // can retry rather than masquerading as success.
      return notFoundResponse("Conflicting item not found after dedupe");
    }
    return NextResponse.json({
      item: serializeVoiceChatCandidateItem(existing),
    });
  } catch (err) {
    if (isBadRequest(err)) {
      return badRequestResponse(err.message);
    }
    throw err;
  }
}
