import { NextResponse } from "next/server";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { z } from "zod";
import { voiceChatTasks } from "@vm0/db/schema/voice-chat";
import type { AuthContext } from "../../../../src/lib/auth/get-auth-context";
import { loadFeatureSwitchOverrides } from "../../../../src/lib/zero/user/feature-switches-service";

export const createVoiceChatTaskBodySchema = z.object({
  prompt: z.string().min(1),
  callId: z.string().min(1),
});

export const voiceChatTokenBodySchema = z.object({
  sessionId: z.uuid(),
  noiseReduction: z.enum(["near_field", "far_field"]).optional(),
});

type TaskRow = typeof voiceChatTasks.$inferSelect;

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

interface VoiceChatGates {
  /** FeatureSwitchKey.Trinity — top-level voice-chat gate (#10618). */
  voiceChatEnabled: boolean;
  /**
   * FeatureSwitchKey.VoiceChatRealtimeBilling — when ON, the token route
   * runs credit + pricing admission and the /session-started, /usage,
   * /session-ended endpoints record + accept browser-reported usage
   * (Plan D, Epic #12128). When OFF, those endpoints are 200 no-ops.
   * Default OFF; staff-org rollout.
   */
  realtimeBillingEnabled: boolean;
}

/**
 * Resolve both voice-chat feature gates with a single overrides load.
 * Use this in routes that need to make per-branch decisions; the older
 * `isVoiceChatEnabled` is kept for callers that only need the Trinity
 * gate.
 */
export async function loadVoiceChatGates(
  authCtx: AuthContext,
): Promise<VoiceChatGates> {
  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  const evalKey = (key: FeatureSwitchKey) => {
    return isFeatureEnabled(key, {
      orgId: authCtx.orgId,
      userId: authCtx.userId,
      overrides,
    });
  };
  return {
    voiceChatEnabled: evalKey(FeatureSwitchKey.Trinity),
    realtimeBillingEnabled: evalKey(FeatureSwitchKey.VoiceChatRealtimeBilling),
  };
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

export function badRequestResponse(
  message: string,
  code: string = "BAD_REQUEST",
): Response {
  return NextResponse.json({ error: { message, code } }, { status: 400 });
}
