import EmailReplyParser from "email-reply-parser";

/**
 * Strip quoted reply text from an email body, returning only the new content.
 * Uses email-reply-parser to detect and remove quoted sections, signatures, etc.
 *
 * Falls back to the full text if stripping fails or produces empty output.
 */
export function stripQuotedReply(text: string): string {
  if (!text.trim()) return text;

  const email = new EmailReplyParser().read(text);
  const visibleText = email.getVisibleText();

  // Fall back to full text if stripping produced empty output
  return visibleText.trim() || text.trim();
}
