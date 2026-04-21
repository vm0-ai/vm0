import { NextResponse, after } from "next/server";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../../src/lib/init-services";
import { getVoiceChatCandidateSession } from "../../../../../../src/lib/zero/voice-chat-candidate/session-service";
import { readVoiceChatCandidateItems } from "../../../../../../src/lib/zero/voice-chat-candidate/item-service";
import {
  createVoiceChatCandidateTask,
  listSessionTasks,
} from "../../../../../../src/lib/zero/voice-chat-candidate/task-service";
import {
  resolveAgentSystemPrompt,
  triggerReasoning,
} from "../../../../../../src/lib/zero/voice-chat-candidate/trigger-reasoning";
import { adaptVoiceChatCandidateTaskTrigger } from "../../../../../../src/lib/zero/voice-chat-candidate/adapt-task-trigger";
import { createZeroRun } from "../../../../../../src/lib/zero/zero-run-service";
import {
  badRequestResponse,
  createVoiceChatCandidateTaskBodySchema,
  isVoiceChatCandidateEnabled,
  notFoundResponse,
  serializeVoiceChatCandidateTask,
  unauthorizedResponse,
} from "../../_support";

export const maxDuration = 60;

const RECENT_ITEMS_LIMIT = 20;

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
  if (session.status !== "active") {
    return badRequestResponse("Session is not active");
  }
  if (!session.agentId) {
    // Null-agent sessions exist in schema (agentId is nullable) but cannot
    // spawn a task run — createZeroRun requires an agentId.
    return badRequestResponse("Session has no agent; cannot spawn task");
  }

  const parsed = createVoiceChatCandidateTaskBodySchema.safeParse(
    await request.json().catch(() => {
      return undefined;
    }),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return badRequestResponse(issue?.message ?? "Invalid request body");
  }

  // Decision H prompt assembly: agent system prompt + reasoner context +
  // recent N items. The adapter is a stateless builder; the route owns the
  // business logic of fetching and formatting these four inputs.
  const agentSystemPrompt = await resolveAgentSystemPrompt(session.agentId);
  const allItems = await readVoiceChatCandidateItems(id);
  const recentItems = allItems.slice(-RECENT_ITEMS_LIMIT);
  const recentFormatted =
    recentItems.length === 0
      ? "(none)"
      : recentItems
          .map((i) => {
            return `[${i.seq}] ${i.role}: ${i.content ?? ""}`;
          })
          .join("\n");
  const reasonerSummary = [
    session.conversationSummary?.trim(),
    session.workingTasksSummary?.trim(),
    session.finishedTasksSummary?.trim(),
  ]
    .filter((s): s is string => {
      return Boolean(s);
    })
    .join("\n\n");
  const appendSystemPrompt = [
    `[Voice chat context]\n${agentSystemPrompt.trim() || "(none)"}`,
    `[Reasoner context]\n${reasonerSummary || "(none)"}`,
    `[Recent items]\n${recentFormatted}`,
  ].join("\n\n");

  const agentId = session.agentId;
  const task = await createVoiceChatCandidateTask({
    sessionId: id,
    callId: parsed.data.callId,
    prompt: parsed.data.prompt,
    spawnRun: (taskId) => {
      const runParams = adaptVoiceChatCandidateTaskTrigger({
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

  after(() => {
    return triggerReasoning(id);
  });

  return NextResponse.json({
    task: serializeVoiceChatCandidateTask(task),
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

  const tasks = await listSessionTasks(id);
  return NextResponse.json({
    tasks: tasks.map(serializeVoiceChatCandidateTask),
  });
}
