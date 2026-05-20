import { buildTelegramPrompt } from "../../integration-prompt";
import type { UserInfoOptions } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { TelegramCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../../zero-run-service";

interface TelegramTriggerContext {
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userInfoExtras?: UserInfoOptions;
  botId?: string;
  botUsername?: string | null;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  rootMessageId?: string | null;
  messageThreadId?: string | number | null;
  userId: string;
  callbackContext: TelegramCallbackPayload;
  apiStartTime: number;
  modelProviderType?: string;
  modelProviderId?: string | null;
  modelProviderCredentialScope?: string;
  selectedModel?: string;
}

export function adaptTelegramTrigger(
  ctx: TelegramTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt:
      buildTelegramPrompt(
        {
          botId: ctx.botId,
          botUsername: ctx.botUsername,
          chatId: ctx.chatId,
          chatType: ctx.chatType,
          messageId: ctx.messageId,
          rootMessageId: ctx.rootMessageId,
          messageThreadId: ctx.messageThreadId,
        },
        ctx.threadContext,
      ) || undefined,
    sessionId: ctx.sessionId,
    triggerSource: "telegram",
    apiStartTime: ctx.apiStartTime,
    userInfoExtras: ctx.userInfoExtras,
    modelProvider: ctx.modelProviderType,
    modelProviderId: ctx.modelProviderId ?? undefined,
    modelProviderCredentialScope: ctx.modelProviderCredentialScope,
    selectedModelOverride: ctx.selectedModel,
    explicitModelFirstModelSelection: Boolean(ctx.selectedModel),
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/telegram`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackContext,
      },
    ],
  };
}
