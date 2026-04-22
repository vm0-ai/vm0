import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../../src/lib/zero/org/resolve-org";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";
import { loadFeatureSwitchOverrides } from "../../../../../../../src/lib/zero/user/feature-switches-service";
import { voiceChatSessions } from "../../../../../../../src/db/schema/voice-chat";
import {
  getVoiceChatTask,
  type VoiceChatTask,
} from "../../../../../../../src/lib/zero/voice-chat/task-service";

export const maxDuration = 30;

function serializeTask(task: VoiceChatTask) {
  return {
    id: task.id,
    sessionId: task.sessionId,
    runId: task.runId,
    prompt: task.prompt,
    status: task.status,
    result: task.result,
    error: task.error,
    assistantMessages: task.assistantMessages,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt ? task.startedAt.toISOString() : null,
    finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
  };
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
    { status: 401 },
  );
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: { message: "Voice chat is not enabled", code: "FORBIDDEN" } },
    { status: 403 },
  );
}

function notFound(message: string): NextResponse {
  return NextResponse.json(
    { error: { message, code: "NOT_FOUND" } },
    { status: 404 },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
): Promise<Response> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { acceptAnySandboxCapability: true },
  );
  if (!authCtx) return unauthorized();

  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.VoiceChat, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    overrides,
  });
  if (!enabled) return forbidden();

  const { org } = await resolveOrg(authCtx);
  const { id, taskId } = await params;

  const [session] = await globalThis.services.db
    .select({ orgId: voiceChatSessions.orgId })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id))
    .limit(1);

  if (!session || session.orgId !== org.orgId) {
    return notFound("Session not found");
  }

  const task = await getVoiceChatTask(taskId);
  if (!task || task.sessionId !== id) {
    return notFound("Task not found");
  }

  return NextResponse.json({ task: serializeTask(task) });
}
