import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";

export function chatEventDisplayText(event: ChatEvent): string | null {
  switch (event.eventType) {
    case "input.prompt":
    case "input.rejected": {
      return event.userMessage.parts
        .flatMap((part) => {
          return part.type === "text" ? [part.text] : [];
        })
        .join("");
    }
    default: {
      return event.content;
    }
  }
}
