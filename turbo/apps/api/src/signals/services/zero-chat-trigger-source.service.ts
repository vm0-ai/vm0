import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";

export function isWebChatTriggerSource(
  triggerSource: TriggerSource,
): triggerSource is Extract<TriggerSource, "web" | "agent"> {
  return triggerSource === "web" || triggerSource === "agent";
}
