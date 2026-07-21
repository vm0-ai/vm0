import type { ChatMessageFeedbackPayload } from "@vm0/db/schema/chat-message";

const FEEDBACK_BLOCK_SEPARATOR = "\n\n---\n\n";

function feedbackIntro(itemCount: number): string {
  return itemCount === 1
    ? "Feedback on this part of your reply:"
    : `Feedback on ${itemCount} parts of your reply:`;
}

function formatQuotedText(quote: string): string {
  return quote
    .split("\n")
    .map((line) => {
      return `> ${line}`;
    })
    .join("\n");
}

export function formatChatMessageForAgent(
  textContent: string,
  feedbackPayload: ChatMessageFeedbackPayload | null | undefined,
): string {
  if (!feedbackPayload) {
    return textContent;
  }

  const feedbackBlocks = feedbackPayload.items.map((item) => {
    return `${formatQuotedText(item.quote)}\n${item.note}`;
  });
  const feedback = `${feedbackIntro(feedbackPayload.items.length)}\n\n${feedbackBlocks.join(FEEDBACK_BLOCK_SEPARATOR)}`;

  return [textContent.trim(), feedback].filter(Boolean).join("\n\n");
}
