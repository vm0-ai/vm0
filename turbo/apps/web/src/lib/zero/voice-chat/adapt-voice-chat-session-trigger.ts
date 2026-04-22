import { generateCallbackSecret, getApiUrl } from "../../infra/callback";
import type { VoiceChatCallbackPayload } from "../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../zero-run-service";

interface VoiceChatSessionTriggerContext {
  userId: string;
  agentId: string;
  prompt: string;
  appendSystemPrompt: string;
  /** voice_chat_sessions.id — used only as the callback payload key. */
  sessionId: string;
  /**
   * Prior voice-chat's agent (CC) session id, if any. Passed through as
   * CreateZeroRunParams.sessionId so the new run restores that CC session
   * and prefers the cached runner VM. Distinct from the voice-chat session
   * id above — these are two different UUIDs.
   */
  continueFromAgentSessionId?: string;
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
    sessionId: ctx.continueFromAgentSessionId,
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/voice-chat`,
        secret: generateCallbackSecret(),
        payload: callbackPayload,
      },
    ],
  };
}
