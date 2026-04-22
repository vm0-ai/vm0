import { NextResponse, after } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";
import { loadFeatureSwitchOverrides } from "../../../../../../src/lib/zero/user/feature-switches-service";
import { voiceChatSessions } from "../../../../../../src/db/schema/voice-chat";
import {
  appendTaskEvent,
  attachTaskRun,
  createVoiceChatTask,
  listVoiceChatTasks,
  type VoiceChatTask,
} from "../../../../../../src/lib/zero/voice-chat/task-service";
import { adaptVoiceChatTaskTrigger } from "../../../../../../src/lib/zero/voice-chat/adapt-voice-chat-task-trigger";
import { resolveAgentSystemPrompt } from "../../../../../../src/lib/zero/voice-chat/resolve-agent-system-prompt";
import { createZeroRun } from "../../../../../../src/lib/zero/zero-run-service";
import { publishUserSignal } from "../../../../../../src/lib/infra/realtime/client";
import { logger } from "../../../../../../src/lib/shared/logger";

export const maxDuration = 60;

const log = logger("api:zero:voice-chat:tasks");

const createTaskBodySchema = z.object({
  prompt: z.string().min(1),
});

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

function notFound(): NextResponse {
  return NextResponse.json(
    { error: { message: "Session not found", code: "NOT_FOUND" } },
    { status: 404 },
  );
}

function badRequest(message: string): NextResponse {
  return NextResponse.json(
    { error: { message, code: "BAD_REQUEST" } },
    { status: 400 },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const apiStartTime = Date.now();
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
  const { id } = await params;

  const [session] = await globalThis.services.db
    .select({
      id: voiceChatSessions.id,
      orgId: voiceChatSessions.orgId,
      userId: voiceChatSessions.userId,
      agentId: voiceChatSessions.agentId,
      status: voiceChatSessions.status,
    })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id))
    .limit(1);

  if (!session || session.orgId !== org.orgId) return notFound();
  if (session.status !== "active" && session.status !== "preparing") {
    return badRequest("Session is not active");
  }
  if (!session.agentId) {
    return badRequest("Session has no agent; cannot spawn task");
  }

  const parsed = createTaskBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequest(issue?.message ?? "Invalid request body");
  }

  const agentSystemPrompt = await resolveAgentSystemPrompt(session.agentId);
  const appendSystemPrompt = agentSystemPrompt.trim();

  const task = await createVoiceChatTask({
    sessionId: id,
    prompt: parsed.data.prompt,
  });

  const runParams = adaptVoiceChatTaskTrigger({
    userId: session.userId,
    agentId: session.agentId,
    taskId: task.id,
    prompt: parsed.data.prompt,
    appendSystemPrompt,
    apiStartTime,
  });
  const run = await createZeroRun(runParams);

  const attached = await attachTaskRun({
    taskId: task.id,
    runId: run.runId,
  });
  await appendTaskEvent(id, {
    type: "task-dispatched",
    taskId: task.id,
    prompt: parsed.data.prompt,
  });

  after(() => {
    return publishUserSignal([session.userId], `voice:${id}`);
  });

  log.info("voice-chat task dispatched", {
    sessionId: id,
    taskId: task.id,
    runId: run.runId,
  });

  return NextResponse.json({ task: serializeTask(attached ?? task) });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
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
  const { id } = await params;

  const [session] = await globalThis.services.db
    .select({ orgId: voiceChatSessions.orgId })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id))
    .limit(1);

  if (!session || session.orgId !== org.orgId) return notFound();

  const tasks = await listVoiceChatTasks(id);
  return NextResponse.json({ tasks: tasks.map(serializeTask) });
}
