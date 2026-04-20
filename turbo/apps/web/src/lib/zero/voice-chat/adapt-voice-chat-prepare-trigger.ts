import { generateCallbackSecret, getApiUrl } from "../../infra/callback";
import type { VoiceChatPrepareCallbackPayload } from "../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../zero-run-service";

interface VoiceChatPrepareTriggerContext {
  userId: string;
  agentId: string;
  prompt: string;
  appendSystemPrompt: string;
  preparationId: string;
}

export function adaptVoiceChatPrepareTrigger(
  ctx: VoiceChatPrepareTriggerContext,
): CreateZeroRunParams {
  const callbackPayload: VoiceChatPrepareCallbackPayload = {
    preparationId: ctx.preparationId,
  };
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt: ctx.appendSystemPrompt,
    triggerSource: "voice-chat",
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/voice-chat-prepare`,
        secret: generateCallbackSecret(),
        payload: callbackPayload,
      },
    ],
  };
}
