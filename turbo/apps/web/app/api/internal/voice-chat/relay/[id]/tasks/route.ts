import { NextResponse, after } from "next/server";
import { initServices } from "../../../../../../../src/lib/init-services";
import { resolveRelayAuth } from "../../../../../../../src/lib/zero/voice-chat/relay-auth";
import { getVoiceChatSession } from "../../../../../../../src/lib/zero/voice-chat/session-service";
import { createVoiceChatTask } from "../../../../../../../src/lib/zero/voice-chat/task-service";
import { buildVoiceChatTaskAppendSystemPrompt } from "../../../../../../../src/lib/zero/voice-chat/build-voice-chat-task-context";
import { triggerReasoning } from "../../../../../../../src/lib/zero/voice-chat/trigger-reasoning";
import { adaptVoiceChatTaskTrigger } from "../../../../../../../src/lib/zero/voice-chat/adapt-task-trigger";
import { publishUserSignal } from "../../../../../../../src/lib/infra/realtime/client";
import { createZeroRun } from "../../../../../../../src/lib/zero/zero-run-service";
import {
  badRequestResponse,
  createVoiceChatTaskBodySchema,
  notFoundResponse,
  serializeVoiceChatTask,
} from "../../../../../zero/voice-chat/_support";

export const maxDuration = 60;

/**
 * Relay-token-gated mirror of POST /api/zero/voice-chat/[id]/tasks.
 *
 * Used by the apps/api WS relay (#12141) to dispatch Talker tool calls
 * (`response.function_call_arguments.done`) into the existing voice-chat
 * task pipeline. Same service-layer call, same Ably + Reasoner fan-out as
 * the user-facing route. Auth is the relay token; the `agentId` is read
 * from the persisted session (relay token's optional `agentId` claim is
 * not trusted for this — sessions can have agents reassigned).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const apiStartTime = Date.now();
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
  if (!session.agentId) {
    return badRequestResponse(
      "Session has no agent; cannot spawn task",
      "NO_AGENT",
    );
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

  const appendSystemPrompt = await buildVoiceChatTaskAppendSystemPrompt({
    sessionId: id,
    agentId: session.agentId,
  });

  const agentId = session.agentId;
  const task = await createVoiceChatTask({
    sessionId: id,
    callId: parsed.data.callId,
    prompt: parsed.data.prompt,
    spawnRun: (taskId) => {
      const runParams = adaptVoiceChatTaskTrigger({
        userId: auth.userId,
        agentId,
        taskId,
        prompt: parsed.data.prompt,
        appendSystemPrompt,
        apiStartTime,
      });
      return createZeroRun(runParams);
    },
  });

  await publishUserSignal([session.userId], `voice-chat:${id}`);
  after(() => {
    return triggerReasoning(id);
  });

  return NextResponse.json({
    task: serializeVoiceChatTask(task),
  });
}
