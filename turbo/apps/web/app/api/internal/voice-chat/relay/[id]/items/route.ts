import { NextResponse, after } from "next/server";
import { and, eq } from "drizzle-orm";
import { initServices } from "../../../../../../../src/lib/init-services";
import { resolveRelayAuth } from "../../../../../../../src/lib/zero/voice-chat/relay-auth";
import { getVoiceChatSession } from "../../../../../../../src/lib/zero/voice-chat/session-service";
import { appendVoiceChatItem } from "../../../../../../../src/lib/zero/voice-chat/item-service";
import { triggerReasoning } from "../../../../../../../src/lib/zero/voice-chat/trigger-reasoning";
import { voiceChatItems } from "@vm0/db/schema/voice-chat";
import { isBadRequest } from "@vm0/api-services/errors";
import {
  appendVoiceChatItemBodySchema,
  badRequestResponse,
  notFoundResponse,
  serializeVoiceChatItem,
} from "../../../../../zero/voice-chat/_support";

export const maxDuration = 60;

/**
 * Relay-token-gated mirror of POST /api/zero/voice-chat/[id]/items.
 *
 * Used by the apps/api WS relay (#12141) to persist transcript items
 * (user / assistant / system_note) it observes from the OpenAI provider
 * stream. Same service-layer call, same idempotency via the
 * (sessionId, realtimeItemId) unique index, same after()/triggerReasoning
 * fan-out as the user-facing route. Auth is the relay token instead of
 * the user's Clerk JWT — claims carry the userId / orgId / sessionId.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const { id } = await params;
  const auth = resolveRelayAuth(request, id);
  if (auth instanceof Response) return auth;

  const session = await getVoiceChatSession(id);
  if (
    !session ||
    session.orgId !== auth.orgId ||
    session.userId !== auth.userId
  ) {
    return notFoundResponse("Voice-chat session not found");
  }

  const parsed = appendVoiceChatItemBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  try {
    const inserted = await appendVoiceChatItem({
      sessionId: id,
      role: parsed.data.role,
      content: parsed.data.content,
      realtimeItemId: parsed.data.realtimeItemId,
    });

    if (inserted) {
      after(() => {
        return triggerReasoning(id);
      });
      return NextResponse.json({
        item: serializeVoiceChatItem(inserted),
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
      return notFoundResponse("Conflicting item not found after dedupe");
    }
    return NextResponse.json({
      item: serializeVoiceChatItem(existing),
    });
  } catch (err) {
    if (isBadRequest(err)) {
      return badRequestResponse(err.message);
    }
    throw err;
  }
}
