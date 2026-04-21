import { generateCallbackSecret, getApiUrl } from "../../infra/callback";
import type { VoiceChatCandidateCallbackPayload } from "../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../zero-run-service";

interface VoiceChatCandidateTaskTriggerContext {
  userId: string;
  agentId: string;
  taskId: string;
  prompt: string;
  appendSystemPrompt: string;
  apiStartTime: number;
}

/**
 * Build CreateZeroRunParams for a voice-chat-candidate task-run. Consumed by
 * the Wave 5 tasks route (#10310); declared in Wave 5 (#10311) alongside the
 * callback it points at so the two halves of the contract ship together.
 */
export function adaptVoiceChatCandidateTaskTrigger(
  ctx: VoiceChatCandidateTaskTriggerContext,
): CreateZeroRunParams {
  const callbackPayload: VoiceChatCandidateCallbackPayload = {
    taskId: ctx.taskId,
  };
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt: ctx.appendSystemPrompt,
    triggerSource: "voice-chat",
    apiStartTime: ctx.apiStartTime,
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/voice-chat-candidate`,
        secret: generateCallbackSecret(),
        payload: callbackPayload,
      },
    ],
  };
}
