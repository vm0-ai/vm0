import { buildIntegrationPrompt } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { CreateZeroRunParams } from "../../zero-run-service";

interface EmailReplyTriggerContext {
  userId: string;
  agentId: string;
  sessionId: string;
  prompt: string;
  apiStartTime: number;
  callbackPayload: {
    emailThreadSessionId: string;
    inboundEmailId: string;
    inboundMessageId: string | undefined;
    inboundReferences: string | undefined;
    replyRecipientTo: string[];
    replyRecipientCc: string[];
  };
}

export function adaptEmailReplyTrigger(
  ctx: EmailReplyTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    prompt: ctx.prompt,
    appendSystemPrompt: buildIntegrationPrompt("Email"),
    triggerSource: "email",
    apiStartTime: ctx.apiStartTime,
    callbacks: [
      {
        url: `${getApiUrl()}/api/zero/email/callbacks/reply`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackPayload,
      },
    ],
  };
}
