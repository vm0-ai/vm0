import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";

type PiMemoryInteractiveChatTriggerSource = Extract<
  TriggerSource,
  | "web"
  | "agent"
  | "slack"
  | "feishu"
  | "teams"
  | "telegram"
  | "agentphone"
  | "github"
>;

const PI_MEMORY_INTERACTIVE_CHAT_TRIGGER_SOURCES = {
  web: true,
  slack: true,
  teams: true,
  feishu: true,
  email: false,
  telegram: true,
  agentphone: true,
  github: true,
  test: false,
  agent: true,
  webhook: false,
  "automation-schedule": false,
  "automation-event": false,
  goal: false,
} as const satisfies Readonly<Record<TriggerSource, boolean>>;

export function isWebChatTriggerSource(
  triggerSource: TriggerSource,
): triggerSource is Extract<TriggerSource, "web" | "agent"> {
  return triggerSource === "web" || triggerSource === "agent";
}

export function isPiMemoryInteractiveChatTriggerSource(
  triggerSource: TriggerSource,
): triggerSource is PiMemoryInteractiveChatTriggerSource {
  return PI_MEMORY_INTERACTIVE_CHAT_TRIGGER_SOURCES[triggerSource];
}
