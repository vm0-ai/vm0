import { buildIMessagePrompt } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { IMessageCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../../zero-run-service";

interface ImessageTriggerContext {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  fromNumber: string;
  userId: string;
  callbackContext: IMessageCallbackPayload;
}

export function adaptImessageTrigger(
  ctx: ImessageTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt: buildIMessagePrompt(ctx.fromNumber) || undefined,
    sessionId: ctx.sessionId,
    triggerSource: "imessage",
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/imessage`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackContext,
      },
    ],
  };
}
