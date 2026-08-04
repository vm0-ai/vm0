import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type {
  ChatEventGenerationTemplate,
  ChatEventUserMessage,
} from "@vm0/db/schema/chat-event";

import type { Db } from "../external/db";
import { resolveThreadGenerationTemplatePrompt } from "../routes/thread-generation-template";
import { loadAgentPhoneQueuedLaunchMaterial } from "./agentphone-queued-launch-context.service";
import { loadFeishuQueuedLaunchMaterial } from "./feishu-queued-launch-context.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { loadSlackQueuedLaunchMaterial } from "./slack-queued-launch-context.service";
import { loadTeamsQueuedLaunchMaterial } from "./teams-queued-launch-context.service";
import { loadTelegramQueuedLaunchMaterial } from "./telegram-queued-launch-context.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";

type ContextBackedTriggerSource =
  | "slack"
  | "feishu"
  | "teams"
  | "telegram"
  | "agentphone";

interface ActiveInputPromptEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly triggerSource: TriggerSource | null;
  readonly userMessage: ChatEventUserMessage;
  readonly generationTemplate: ChatEventGenerationTemplate | null;
}

interface IntegrationPromptMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
}

const CONTEXT_BACKED_TRIGGER_SOURCES: readonly ContextBackedTriggerSource[] = [
  "slack",
  "feishu",
  "teams",
  "telegram",
  "agentphone",
];

function isContextBackedTriggerSource(
  source: TriggerSource | null,
): source is ContextBackedTriggerSource {
  return CONTEXT_BACKED_TRIGGER_SOURCES.some((candidate) => {
    return candidate === source;
  });
}

async function loadIntegrationPromptMaterial(
  db: Db,
  event: ActiveInputPromptEvent,
  args: { readonly orgId: string; readonly userId: string },
): Promise<IntegrationPromptMaterial | null> {
  const loaderArgs = {
    eventId: event.id,
    chatThreadId: event.chatThreadId,
    orgId: args.orgId,
    userId: args.userId,
  };
  switch (event.triggerSource) {
    case "slack": {
      return await loadSlackQueuedLaunchMaterial(db, loaderArgs);
    }
    case "feishu": {
      return await loadFeishuQueuedLaunchMaterial(db, loaderArgs);
    }
    case "teams": {
      return await loadTeamsQueuedLaunchMaterial(db, loaderArgs);
    }
    case "telegram": {
      return await loadTelegramQueuedLaunchMaterial(db, loaderArgs);
    }
    case "agentphone": {
      return await loadAgentPhoneQueuedLaunchMaterial(db, loaderArgs);
    }
    default: {
      return null;
    }
  }
}

/** Materialize one claimed input prompt into the same text capability as a run prompt. */
export async function materializeActiveInputPrompt(
  db: Db,
  args: {
    readonly event: ActiveInputPromptEvent;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<string> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    args.orgId,
    args.userId,
  );
  const inlineTemplatesEnabled = isFeatureEnabled(
    FeatureSwitchKey.StructuredPromptInlineTemplates,
    featureSwitchContext,
  );
  const userMessage = requiredUserMessageForEvent(
    "input.prompt",
    args.event.userMessage,
  );
  if (!userMessage) {
    throw new Error("Active input event is missing userMessage");
  }
  const projection = projectUserMessage(userMessage, {
    inlineTemplates: inlineTemplatesEnabled,
  });
  const integration = await loadIntegrationPromptMaterial(db, args.event, args);
  if (isContextBackedTriggerSource(args.event.triggerSource) && !integration) {
    throw new Error(
      `${args.event.triggerSource} active input is missing launch material`,
    );
  }
  const generationTemplatePrompt = resolveThreadGenerationTemplatePrompt({
    explicit: projection.generationTemplate ?? args.event.generationTemplate,
    explicitTemplates: inlineTemplatesEnabled
      ? projection.generationTemplates
      : undefined,
  });
  const prompt = integration?.prompt ?? projection.agentPrompt;
  const parts = [
    integration?.appendSystemPrompt ?? "",
    generationTemplatePrompt,
    prompt,
  ].filter((part) => {
    return part.length > 0;
  });
  const materialized = parts.join("\n\n");
  if (materialized.length === 0) {
    throw new Error("Active input event materialized to an empty prompt");
  }
  return materialized;
}
