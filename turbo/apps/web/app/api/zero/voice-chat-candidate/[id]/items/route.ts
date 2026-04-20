import { NextResponse, after } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import { getVoiceChatCandidateSession } from "../../../../../../src/lib/zero/voice-chat-candidate/session-service";
import {
  appendVoiceChatCandidateItem,
  readVoiceChatCandidateItems,
} from "../../../../../../src/lib/zero/voice-chat-candidate/item-service";
import { triggerReasoning } from "../../../../../../src/lib/zero/voice-chat-candidate/trigger-reasoning";
import { featureCandidateVoiceChatItems } from "../../../../../../src/db/schema/voice-chat-candidate";
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
      // Fresh insert — tick the reasoner asynchronously. Silent-dedupe
      // replays (null return, see below) intentionally skip this to avoid
      // wasted reasoner calls on idempotent retries.
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
      .from(featureCandidateVoiceChatItems)
      .where(
        and(
          eq(featureCandidateVoiceChatItems.sessionId, id),
          eq(
            featureCandidateVoiceChatItems.realtimeItemId,
            parsed.data.realtimeItemId,
          ),
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

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

  const afterParam = new URL(request.url).searchParams.get("after");
  const afterSeq = afterParam !== null ? Number(afterParam) : undefined;
  if (afterSeq !== undefined && !Number.isFinite(afterSeq)) {
    return badRequestResponse("Invalid 'after' query parameter");
  }

  const items = await readVoiceChatCandidateItems(id, afterSeq);
  return NextResponse.json({
    items: items.map((i) => {
      return serializeVoiceChatCandidateItem(i);
    }),
  });
}
