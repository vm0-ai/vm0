import { buildIntegrationPrompt } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { CreateZeroRunParams } from "../../zero-run-service";

interface EmailTriggerTriggerContext {
  userId: string;
  agentId: string;
  prompt: string;
  apiStartTime: number;
  callbackPayload: {
    senderEmail: string;
    agentId: string;
    userId: string;
    inboundEmailId: string;
    replyToken: string;
    inboundMessageId: string | undefined;
    inboundReferences: string | undefined;
    subject: string;
    runtimeOrgId: string;
    replyRecipientTo: string[];
    replyRecipientCc: string[];
  };
}

export function adaptEmailTriggerTrigger(
  ctx: EmailTriggerTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt: buildIntegrationPrompt("Email"),
    triggerSource: "email",
    apiStartTime: ctx.apiStartTime,
    callbacks: [
      {
        url: `${getApiUrl()}/api/zero/email/callbacks/trigger`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackPayload,
      },
    ],
  };
}
