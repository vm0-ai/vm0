import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";

export function isWebChatTriggerSource(
  triggerSource: TriggerSource,
): triggerSource is Extract<TriggerSource, "web" | "agent"> {
  return triggerSource === "web" || triggerSource === "agent";
}
