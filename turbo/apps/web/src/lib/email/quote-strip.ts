import EmailReplyParser from "email-reply-parser";

/**
 * Strip quoted reply text from an email body, returning only the new content.
 * Uses email-reply-parser to detect and remove quoted sections, signatures, etc.
 *
 * Returns empty string if no new content is found — callers should handle this.
 */
export function stripQuotedReply(text: string): string {
  if (!text.trim()) return "";

  const email = new EmailReplyParser().read(text);
  return email.getVisibleText().trim();
}
