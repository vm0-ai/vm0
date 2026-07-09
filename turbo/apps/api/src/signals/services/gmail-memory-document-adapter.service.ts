import type { MemoryConnectorDocumentAdapter } from "./zero-memory-connector-adapter.service";

interface GmailMemoryDocumentInput {
  readonly mailboxEmail: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly occurredAt: Date | null;
  readonly direction: "sent" | "received" | "unknown";
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly reason: string;
}

function gmailDocumentContent(input: GmailMemoryDocumentInput): string {
  return [
    input.subject ? `# ${input.subject}` : "# Gmail message",
    "",
    input.from ? `From: ${input.from}` : null,
    input.to.length > 0 ? `To: ${input.to.join(", ")}` : null,
    input.cc.length > 0 ? `Cc: ${input.cc.join(", ")}` : null,
    `Direction: ${input.direction}`,
    "",
    input.bodyText ?? "",
  ]
    .filter((line): line is string => {
      return line !== null;
    })
    .join("\n");
}

export function gmailMemoryDocumentAdapter(
  input: GmailMemoryDocumentInput,
): ReturnType<MemoryConnectorDocumentAdapter<GmailMemoryDocumentInput>> {
  if (!input.bodyText?.trim()) {
    return null;
  }
  const conversationId = input.threadId ?? input.messageId;
  return {
    provider: "gmail",
    sourceType: "gmail_message",
    externalId: input.messageId,
    title: input.subject,
    content: gmailDocumentContent(input),
    occurredAt: input.occurredAt,
    contextSpace: {
      type: "user",
      key: `gmail:${input.mailboxEmail}:${conversationId}`,
      displayName: input.subject ?? "Gmail conversation",
      metadata: {
        provider: "gmail",
        externalId: conversationId,
        displayName: input.subject ?? "Gmail conversation",
        reason: input.reason,
      },
    },
    metadata: {
      provider: "gmail",
      sourceType: "gmail_message",
      mailboxEmail: input.mailboxEmail,
      threadId: input.threadId,
      messageId: input.messageId,
      direction: input.direction,
      reason: input.reason,
    },
    citation: {
      url: `https://mail.google.com/mail/u/${encodeURIComponent(input.mailboxEmail)}/#all/${conversationId}`,
      locator: input.messageId,
    },
  };
}
