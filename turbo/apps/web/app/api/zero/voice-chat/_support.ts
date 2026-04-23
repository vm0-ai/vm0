import { NextResponse } from "next/server";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { z } from "zod";
import {
  voiceChatItems,
  voiceChatSessions,
  voiceChatTasks,
} from "../../../../src/db/schema/voice-chat";
import type { AuthContext } from "../../../../src/lib/auth/get-auth-context";
import { loadFeatureSwitchOverrides } from "../../../../src/lib/zero/user/feature-switches-service";

export const createVoiceChatSessionBodySchema = z.object({
  agentId: z.uuid(),
});

export const appendVoiceChatItemBodySchema = z.object({
  role: z.enum(["user", "assistant", "task_result", "system_note"]),
  content: z.string(),
  realtimeItemId: z.string().min(1),
});

export const createVoiceChatTaskBodySchema = z.object({
  prompt: z.string().min(1),
  callId: z.string().min(1),
});

export const voiceChatTokenBodySchema = z.object({
  sessionId: z.uuid(),
  noiseReduction: z.enum(["near_field", "far_field"]).optional(),
});

type SessionRow = typeof voiceChatSessions.$inferSelect;
type ItemRow = typeof voiceChatItems.$inferSelect;
type TaskRow = typeof voiceChatTasks.$inferSelect;

export function serializeVoiceChatSession(session: SessionRow) {
  return {
    id: session.id,
    orgId: session.orgId,
    userId: session.userId,
    agentId: session.agentId,
    mode: "chat" as const,
    conversationSummary: session.conversationSummary,
    workingTasksSummary: session.workingTasksSummary,
    finishedTasksSummary: session.finishedTasksSummary,
    summarySeq: session.summarySeq,
    summaryVersion: session.summaryVersion,
    lastSummaryAt: session.lastSummaryAt
      ? session.lastSummaryAt.toISOString()
      : null,
    createdAt: session.createdAt.toISOString(),
  };
}

export function serializeVoiceChatItem(item: ItemRow) {
  return {
    id: item.id,
    sessionId: item.sessionId,
    seq: item.seq,
    role: item.role,
    content: item.content,
    taskId: item.taskId,
    realtimeItemId: item.realtimeItemId,
    createdAt: item.createdAt.toISOString(),
  };
}

export function serializeVoiceChatTask(task: TaskRow) {
  return {
    id: task.id,
    sessionId: task.sessionId,
    runId: task.runId,
    callId: task.callId,
    prompt: task.prompt,
    status: task.status,
    result: task.result,
    resultUpdatedAt: task.resultUpdatedAt
      ? task.resultUpdatedAt.toISOString()
      : null,
    assistantMessages: task.assistantMessages,
    error: task.error,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt ? task.startedAt.toISOString() : null,
    finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
  };
}

// Gate on Trinity — the voice-chat surface's dedicated flag introduced in
// #10618. Trinity is the only UI entry point into these endpoints (the
// standalone /voice-chat page was removed in #10627), so the
// backend follows the same switch.
export async function isVoiceChatEnabled(
  authCtx: AuthContext,
): Promise<boolean> {
  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.Trinity, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    overrides,
  });
}

export function unauthorizedResponse(): Response {
  return NextResponse.json(
    { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
    { status: 401 },
  );
}

export function forbiddenResponse(): Response {
  return NextResponse.json(
    { error: { message: "Voice chat is not enabled", code: "FORBIDDEN" } },
    { status: 403 },
  );
}

export function notFoundResponse(message: string): Response {
  return NextResponse.json(
    { error: { message, code: "NOT_FOUND" } },
    { status: 404 },
  );
}

export function badRequestResponse(message: string): Response {
  return NextResponse.json(
    { error: { message, code: "BAD_REQUEST" } },
    { status: 400 },
  );
}
