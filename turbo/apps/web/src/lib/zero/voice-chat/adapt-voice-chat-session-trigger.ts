import { generateCallbackSecret, getApiUrl } from "../../infra/callback";
import type { VoiceChatCallbackPayload } from "../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../zero-run-service";

interface VoiceChatSessionTriggerContext {
  userId: string;
  agentId: string;
  prompt: string;
  appendSystemPrompt: string;
  sessionId: string;
  apiStartTime: number;
}

export function adaptVoiceChatSessionTrigger(
  ctx: VoiceChatSessionTriggerContext,
): CreateZeroRunParams {
  const callbackPayload: VoiceChatCallbackPayload = {
    sessionId: ctx.sessionId,
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
        url: `${getApiUrl()}/api/internal/callbacks/voice-chat`,
        secret: generateCallbackSecret(),
        payload: callbackPayload,
      },
    ],
  };
}
