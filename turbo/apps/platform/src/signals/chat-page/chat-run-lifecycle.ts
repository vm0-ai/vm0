import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";

export function isCancelledAssistantMessage(
  message: PagedChatMessage,
): boolean {
  return (
    message.role === "assistant" &&
    message.runId !== undefined &&
    (message.runLifecycleEvent === "cancelled" ||
      message.error?.trim().toLowerCase() === "run cancelled")
  );
}
