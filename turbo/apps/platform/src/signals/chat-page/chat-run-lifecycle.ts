import type { ChatMessage } from "./chat-message-types.ts";

export function isCancelledAssistantMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    message.runId !== undefined &&
    (message.runLifecycleEvent === "cancelled" ||
      message.error?.trim().toLowerCase() === "run cancelled")
  );
}
