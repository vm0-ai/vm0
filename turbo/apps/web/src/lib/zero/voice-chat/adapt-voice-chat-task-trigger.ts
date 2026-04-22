import { generateCallbackSecret, getApiUrl } from "../../infra/callback";
import type { VoiceChatTaskCallbackPayload } from "../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../zero-run-service";

interface VoiceChatTaskTriggerContext {
  userId: string;
  agentId: string;
  taskId: string;
  prompt: string;
  appendSystemPrompt: string;
  apiStartTime: number;
}

export function adaptVoiceChatTaskTrigger(
  ctx: VoiceChatTaskTriggerContext,
): CreateZeroRunParams {
  const callbackPayload: VoiceChatTaskCallbackPayload = {
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
        url: `${getApiUrl()}/api/internal/callbacks/voice-chat-task`,
        secret: generateCallbackSecret(),
        payload: callbackPayload,
      },
    ],
  };
}
