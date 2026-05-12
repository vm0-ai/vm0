import { buildIMessagePrompt } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { IMessageCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { UserInfoOptions } from "../../integration-prompt";
import type { CreateZeroRunParams } from "../../zero-run-service";
import { requireOfficialIMessageNumber } from "../constants";

interface IMessageTriggerContext {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userInfoExtras?: UserInfoOptions;
  phoneHandle: string;
  conversationId: string | null;
  messageId: string;
  userId: string;
  callbackContext: IMessageCallbackPayload;
  apiStartTime: number;
}

export function adaptIMessageTrigger(
  ctx: IMessageTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt:
      buildIMessagePrompt(
        {
          sharedNumber: requireOfficialIMessageNumber(),
          phoneHandle: ctx.phoneHandle,
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
        },
        ctx.threadContext,
      ) || undefined,
    sessionId: ctx.sessionId,
    triggerSource: "imessage",
    apiStartTime: ctx.apiStartTime,
    userInfoExtras: ctx.userInfoExtras,
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/imessage`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackContext,
      },
    ],
  };
}
