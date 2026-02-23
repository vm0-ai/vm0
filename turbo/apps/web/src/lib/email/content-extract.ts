import { convert } from "html-to-text";
import { stripQuotedReply } from "./quote-strip";

/**
 * Extract email body content following RFC 2046 priority:
 * 1. Prefer HTML (converted to plain text) if available
 * 2. Fallback to plain text
 * 3. Strip quoted replies from the result
 */
export function extractEmailBody(html: string, text: string): string {
  const raw = html ? convert(html) : text;
  return stripQuotedReply(raw);
}
