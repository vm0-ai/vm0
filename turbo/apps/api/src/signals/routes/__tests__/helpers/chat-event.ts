import type {
  ChatEvent,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

type UserMessagePart = UserMessageDocument["parts"][number];
type AutomationPart = Extract<UserMessagePart, { readonly type: "automation" }>;

export function chatEventAutomationPart(
  event: ChatEvent,
): AutomationPart | undefined {
  if (!("userMessage" in event) || !event.userMessage) {
    return undefined;
  }
  return event.userMessage.parts.find((part): part is AutomationPart => {
    return part.type === "automation";
  });
}

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
