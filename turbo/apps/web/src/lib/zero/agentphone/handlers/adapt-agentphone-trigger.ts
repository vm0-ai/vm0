import { buildAgentPhonePrompt } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { AgentPhoneCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { UserInfoOptions } from "../../integration-prompt";
import type { CreateZeroRunParams } from "../../zero-run-service";
import { requireOfficialAgentPhoneNumber } from "../constants";

interface AgentPhoneTriggerContext {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userInfoExtras?: UserInfoOptions;
  phoneHandle: string;
  conversationId: string | null;
  messageId: string;
  userId: string;
  callbackContext: AgentPhoneCallbackPayload;
  apiStartTime: number;
}

export function adaptAgentPhoneTrigger(
  ctx: AgentPhoneTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt:
      buildAgentPhonePrompt(
        {
          sharedNumber: requireOfficialAgentPhoneNumber(),
          phoneHandle: ctx.phoneHandle,
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
        },
        ctx.threadContext,
      ) || undefined,
    sessionId: ctx.sessionId,
    triggerSource: "agentphone",
    apiStartTime: ctx.apiStartTime,
    userInfoExtras: ctx.userInfoExtras,
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/agentphone`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackContext,
      },
    ],
  };
}
