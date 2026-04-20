import { buildPhonePrompt } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { PhoneCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../../zero-run-service";

interface PhoneTriggerContext {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  phoneContext: string;
  userId: string;
  callbackContext: PhoneCallbackPayload;
}

export function adaptPhoneTrigger(
  ctx: PhoneTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt: buildPhonePrompt(ctx.phoneContext) || undefined,
    sessionId: ctx.sessionId,
    triggerSource: "phone",
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/phone`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackContext,
      },
    ],
  };
}
