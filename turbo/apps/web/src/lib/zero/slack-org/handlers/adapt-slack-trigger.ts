import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { SlackOrgCallbackPayload } from "../../../infra/callback/callback-payloads";
import { buildSlackPrompt } from "../../integration-prompt";
import type { UserInfoOptions } from "../../integration-prompt";
import type { CreateZeroRunParams } from "../../zero-run-service";

interface SlackTriggerContext {
  userId: string;
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userInfoExtras?: UserInfoOptions;
  botUserId: string;
  channelId?: string;
  channelType?: "channel" | "dm" | "group_dm";
  threadTs?: string;
  callbackContext: SlackOrgCallbackPayload;
  apiStartTime: number;
  modelProviderType?: string;
  modelProviderId?: string | null;
  modelProviderCredentialScope?: string;
  selectedModel?: string;
}

/**
 * Pure transform: Slack trigger input → createZeroRun params.
 */
export function adaptSlackTrigger(
  ctx: SlackTriggerContext,
): CreateZeroRunParams {
  const appendSystemPrompt =
    buildSlackPrompt(
      {
        botUserId: ctx.botUserId,
        channelId: ctx.channelId,
        channelType: ctx.channelType,
        threadId: ctx.threadTs,
      },
      ctx.threadContext,
    ) || undefined;

  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    prompt: ctx.prompt,
    appendSystemPrompt,
    sessionId: ctx.sessionId,
    triggerSource: "slack",
    apiStartTime: ctx.apiStartTime,
    userInfoExtras: ctx.userInfoExtras,
    modelProvider: ctx.modelProviderType,
    modelProviderId: ctx.modelProviderId ?? undefined,
    modelProviderCredentialScope: ctx.modelProviderCredentialScope,
    selectedModelOverride: ctx.selectedModel,
    explicitModelFirstModelSelection: Boolean(ctx.selectedModel),
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/slack/org`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackContext,
      },
    ],
  };
}
