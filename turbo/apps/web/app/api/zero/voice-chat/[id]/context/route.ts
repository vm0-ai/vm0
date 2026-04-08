import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { isFeatureEnabled, FeatureSwitchKey } from "@vm0/core";
import { eq } from "drizzle-orm";
import { voiceChatSessions } from "../../../../../../src/db/schema/voice-chat";
import {
  readEvents,
  appendEvent,
} from "../../../../../../src/lib/zero/voice-chat/context-service";

const VALID_SOURCES = ["system", "user", "talker", "worker"] as const;
const VALID_TYPES = [
  "session-start",
  "session-end",
  "speech",
  "acknowledgement",
  "worker-request",
  "progress",
  "result",
  "response",
] as const;

const appendEventBodySchema = z.object({
  source: z.enum(VALID_SOURCES),
  type: z.enum(VALID_TYPES),
  content: z.string().optional(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();
  const { id } = await params;

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined, {
    acceptAnySandboxCapability: true,
  });
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const enabled = isFeatureEnabled(FeatureSwitchKey.VoiceChat, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
  });
  if (!enabled) {
    return NextResponse.json(
      { error: { message: "Voice chat is not enabled", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  const { org } = await resolveOrg(authCtx);

  const [session] = await globalThis.services.db
    .select({ orgId: voiceChatSessions.orgId })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id))
    .limit(1);

  if (!session || session.orgId !== org.orgId) {
    return NextResponse.json(
      { error: { message: "Session not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const afterParam = url.searchParams.get("after");
  const afterSeq = afterParam ? parseInt(afterParam, 10) : undefined;

  const events = await readEvents(id, afterSeq);

  return NextResponse.json({ events });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();
  const { id } = await params;

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined, {
    acceptAnySandboxCapability: true,
  });
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const enabled = isFeatureEnabled(FeatureSwitchKey.VoiceChat, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
  });
  if (!enabled) {
    return NextResponse.json(
      { error: { message: "Voice chat is not enabled", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  const { org } = await resolveOrg(authCtx);

  const [session] = await globalThis.services.db
    .select({ orgId: voiceChatSessions.orgId })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id))
    .limit(1);

  if (!session || session.orgId !== org.orgId) {
    return NextResponse.json(
      { error: { message: "Session not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  const parsed = appendEventBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: {
          message: issue
            ? `Invalid ${String(issue.path[0])}: ${issue.message}`
            : "Invalid request body",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const { source, type, content } = parsed.data;

  try {
    const event = await appendEvent(id, source, type, content);
    return NextResponse.json({ event });
  } catch (err) {
    const error = err as { message: string; code?: string };
    if (error.code === "BAD_REQUEST") {
      return NextResponse.json(
        { error: { message: error.message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
    throw err;
  }
}
