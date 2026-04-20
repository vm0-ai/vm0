import { buildTelegramPrompt } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { TelegramCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../../zero-run-service";

interface TelegramTriggerContext {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  callbackContext: TelegramCallbackPayload;
  apiStartTime: number;
}

export function adaptTelegramTrigger(
  ctx: TelegramTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt: buildTelegramPrompt(ctx.threadContext) || undefined,
    sessionId: ctx.sessionId,
    triggerSource: "telegram",
    apiStartTime: ctx.apiStartTime,
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/telegram`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackContext,
      },
    ],
  };
}
