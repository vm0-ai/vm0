import { ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES } from "@vm0/api-contracts/contracts/runners";
import type {
  ChatEventUserMessage,
  chatEvents,
} from "@vm0/db/schema/chat-event";

import type { Db } from "../external/db";
import { resolveThreadGenerationTemplatePrompt } from "../../lib/thread-generation-template";
import { loadAgentPhoneQueuedLaunchMaterial } from "./agentphone-queued-launch-context.service";
import { loadFeishuQueuedLaunchMaterial } from "./feishu-queued-launch-context.service";
import { loadSlackQueuedLaunchMaterial } from "./slack-queued-launch-context.service";
import { loadTeamsQueuedLaunchMaterial } from "./teams-queued-launch-context.service";
import { loadTelegramQueuedLaunchMaterial } from "./telegram-queued-launch-context.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";

type ChatEventContextType = NonNullable<
  (typeof chatEvents.$inferSelect)["contextType"]
>;

type ContextBackedContextType =
  | "slack"
  | "feishu"
  | "teams"
  | "telegram"
  | "agentphone";

interface ActiveInputPromptEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: "input.prompt" | "input.budget";
  readonly contextType: ChatEventContextType;
  readonly userMessage: ChatEventUserMessage;
}

interface IntegrationPromptMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
}

const CONTEXT_BACKED_CONTEXT_TYPES: readonly ContextBackedContextType[] = [
  "slack",
  "feishu",
  "teams",
  "telegram",
  "agentphone",
];

export function activeInputPromptFitsControlPayload(prompt: string): boolean {
  const payload = JSON.stringify({ type: "active-input", text: prompt });
  return (
    new TextEncoder().encode(payload).byteLength <=
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES
  );
}

function isContextBackedContextType(
  contextType: ChatEventContextType,
): contextType is ContextBackedContextType {
  return CONTEXT_BACKED_CONTEXT_TYPES.some((candidate) => {
    return candidate === contextType;
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
  switch (event.contextType) {
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
    case "web":
    case "github":
    case "automation":
    case "goal":
    case "morning_brief":
    case "agent_run": {
      return null;
    }
    default: {
      return unreachableActiveInputContextType(event.contextType);
    }
  }
}

function unreachableActiveInputContextType(contextType: never): never {
  throw new Error(`Unsupported active input context type: ${contextType}`);
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
  const userMessage = requiredUserMessageForEvent(
    args.event.eventType,
    args.event.userMessage,
  );
  if (!userMessage) {
    throw new Error("Active input event is missing userMessage");
  }
  const projection = projectUserMessage(userMessage);
  const integration = await loadIntegrationPromptMaterial(db, args.event, args);
  if (isContextBackedContextType(args.event.contextType) && !integration) {
    throw new Error(
      `${args.event.contextType} active input is missing launch material`,
    );
  }
  const generationTemplatePrompt = resolveThreadGenerationTemplatePrompt({
    explicit: projection.primaryTemplate,
    explicitTemplates: projection.templates,
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
