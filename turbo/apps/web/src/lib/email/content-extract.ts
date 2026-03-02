import { convert, type FormatCallback } from "html-to-text";
import { stripQuotedReply } from "./quote-strip";

/**
 * Custom image formatter that replaces data URIs with a short placeholder.
 *
 * Gmail sends single-image emails as inline images. Resend converts the CID
 * references to base64 data URIs in the HTML body. Without this formatter,
 * html-to-text outputs the full base64 string (500KB+), causing the prompt
 * to exceed size limits. The actual image data is handled separately through
 * the attachment pipeline (Resend attachments API → R2 → presigned URL).
 */
const inlineImageFormatter: FormatCallback = (
  elem,
  _walk,
  builder,
  formatOptions,
) => {
  const attribs = (elem.attribs ?? {}) as Record<string, string>;
  const src = attribs.src ?? "";
  const alt = attribs.alt ?? "";

  if (src.startsWith("data:")) {
    builder.addInline(alt ? `[inline image: ${alt}]` : "[inline image]");
    return;
  }

  // Default image behavior for non-data URIs (http, cid, etc.)
  const brackets = formatOptions.linkBrackets ?? ["[", "]"];
  const open = brackets ? brackets[0] : "";
  const close = brackets ? brackets[1] : "";
  const srcText = src ? `${open}${src}${close}` : "";
  const text = alt && srcText ? `${alt} ${srcText}` : alt || srcText;
  if (text) {
    builder.addInline(text, { noWordTransform: true });
  }
};

/**
 * Extract email body content following RFC 2046 priority:
 * 1. Prefer HTML (converted to plain text) if available
 * 2. Fallback to plain text
 * 3. Strip quoted replies from the result
 */
export function extractEmailBody(html: string, text: string): string {
  const raw = html
    ? convert(html, {
        formatters: { inlineImageFormatter },
        selectors: [{ selector: "img", format: "inlineImageFormatter" }],
      })
    : text;
  return stripQuotedReply(raw);
}
