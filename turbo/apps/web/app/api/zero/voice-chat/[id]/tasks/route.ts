import { NextResponse, after } from "next/server";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import { getVoiceChatSession } from "../../../../../../src/lib/zero/voice-chat/session-service";
import { readVoiceChatItems } from "../../../../../../src/lib/zero/voice-chat/item-service";
import {
  createVoiceChatTask,
  listSessionTasks,
  listSessionTasksForCard,
} from "../../../../../../src/lib/zero/voice-chat/task-service";
import { buildSlowBrainAppendSystemPrompt } from "../../../../../../src/lib/zero/voice-chat/build-slow-brain-prompt";
import {
  resolveAgentSystemPrompt,
  triggerReasoning,
} from "../../../../../../src/lib/zero/voice-chat/trigger-reasoning";
import { adaptVoiceChatTaskTrigger } from "../../../../../../src/lib/zero/voice-chat/adapt-task-trigger";
import { publishUserSignal } from "../../../../../../src/lib/infra/realtime/client";
import { createZeroRun } from "../../../../../../src/lib/zero/zero-run-service";
import {
  badRequestResponse,
  createVoiceChatTaskBodySchema,
  isVoiceChatEnabled,
  notFoundResponse,
  serializeVoiceChatTask,
  unauthorizedResponse,
} from "../../_support";

export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const apiStartTime = Date.now();
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx?.orgId) return unauthorizedResponse();

  // See [id]/route.ts for why this is 404 (not 403) on flag-off.
  if (!(await isVoiceChatEnabled(authCtx))) {
    return notFoundResponse("Voice-chat session not found");
  }

  const { id } = await params;
  const session = await getVoiceChatSession(id);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat session not found");
  }
  if (!session.agentId) {
    // Null-agent sessions exist in schema (agentId is nullable) but cannot
    // spawn a task run — createZeroRun requires an agentId.
    return badRequestResponse("Session has no agent; cannot spawn task");
  }

  const parsed = createVoiceChatTaskBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  const [agentSystemPrompt, allItems, sessionTasks] = await Promise.all([
    resolveAgentSystemPrompt(session.agentId),
    readVoiceChatItems(id),
    listSessionTasks(id),
  ]);
  const appendSystemPrompt = buildSlowBrainAppendSystemPrompt({
    agentSystemPrompt,
    items: allItems,
    sessionTasks,
  });

  const agentId = session.agentId;
  const task = await createVoiceChatTask({
    sessionId: id,
    callId: parsed.data.callId,
    prompt: parsed.data.prompt,
    spawnRun: (taskId) => {
      const runParams = adaptVoiceChatTaskTrigger({
        userId: authCtx.userId,
        agentId,
        taskId,
        prompt: parsed.data.prompt,
        appendSystemPrompt,
        apiStartTime,
      });
      return createZeroRun(runParams);
    },
  });

  // Fast path: publish immediately so the browser refreshes the Talker
  // instruction and sees the new task in the DB-backed Task board, without
  // waiting for the reasoner LLM. The reasoner tick runs in after() and will
  // publish again when it completes (for the conversation summary + compact
  // side-effects).
  await publishUserSignal([session.userId], `voice-chat:${id}`);
  after(() => {
    return triggerReasoning(id);
  });

  return NextResponse.json({
    task: serializeVoiceChatTask(task),
  });
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

  if (!(await isVoiceChatEnabled(authCtx))) {
    return notFoundResponse("Voice-chat session not found");
  }

  const { id } = await params;
  const session = await getVoiceChatSession(id);
  if (
    !session ||
    session.orgId !== authCtx.orgId ||
    session.userId !== authCtx.userId
  ) {
    return notFoundResponse("Voice-chat session not found");
  }

  const tasks = await listSessionTasksForCard(id);
  return NextResponse.json({
    tasks: tasks.map(serializeVoiceChatTask),
  });
}
