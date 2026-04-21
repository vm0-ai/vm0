import { NextResponse, after } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { isFeatureEnabled, FeatureSwitchKey } from "@vm0/core";
import { eq } from "drizzle-orm";
import { loadFeatureSwitchOverrides } from "../../../../../../src/lib/zero/user/feature-switches-service";
import { voiceChatSessions } from "../../../../../../src/db/schema/voice-chat";
import {
  readEvents,
  appendEvent,
} from "../../../../../../src/lib/zero/voice-chat/context-service";
import { publishUserSignal } from "../../../../../../src/lib/infra/realtime/client";

const VALID_SOURCES = ["system", "user", "fast-brain", "slow-brain"] as const;
const VALID_TYPES = [
  "session-start",
  "session-end",
  "speech",
  "request-slow-brain",
  "response",
  "directive",
  "thinking",
  "observation",
  "preparation-ready",
  "meeting-prompt",
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

  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.VoiceChat, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    overrides,
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

  if (afterSeq !== undefined && (Number.isNaN(afterSeq) || afterSeq < 0)) {
    return NextResponse.json(
      { error: { message: "Invalid after parameter", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

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

  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.VoiceChat, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    overrides,
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

    // Notify session participants that context changed
    after(() => {
      return publishUserSignal([authCtx.userId], `voice:${id}`);
    });

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
