/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Convert standard Markdown to Telegram-supported HTML subset.
 *
 * Supported conversions (mirrors apps/web/src/lib/zero/telegram/format.ts):
 * - **bold** -> <b>bold</b>
 * - *italic* -> <i>italic</i>
 * - `code` -> <code>code</code>
 * - ```lang\nblock\n``` -> <pre>block</pre>
 * - [text](url) -> <a href="url">text</a>
 */
function markdownToTelegramHtml(markdown: string): string {
  let result = "";
  let remaining = markdown;

  while (remaining.length > 0) {
    const codeBlockMatch = remaining.match(/^```[^\n]*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      const content = codeBlockMatch[1] as string;
      result += `<pre>${escapeHtml(content)}</pre>`;
      remaining = remaining.slice(codeBlockMatch[0].length);
      continue;
    }

    const inlineCodeMatch = remaining.match(/^`([^`]+)`/);
    if (inlineCodeMatch) {
      const content = inlineCodeMatch[1] as string;
      result += `<code>${escapeHtml(content)}</code>`;
      remaining = remaining.slice(inlineCodeMatch[0].length);
      continue;
    }

    const imageMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      const altText = (imageMatch[1] as string) || "image";
      const imageUrl = imageMatch[2] as string;
      result += `<a href="${escapeHtml(imageUrl)}">🖼 ${escapeHtml(altText)}</a>`;
      remaining = remaining.slice(imageMatch[0].length);
      continue;
    }

    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const linkText = linkMatch[1] as string;
      const linkUrl = linkMatch[2] as string;
      result += `<a href="${escapeHtml(linkUrl)}">${escapeHtml(linkText)}</a>`;
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      const content = boldMatch[1] as string;
      result += `<b>${escapeHtml(content)}</b>`;
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      const content = italicMatch[1] as string;
      result += `<i>${escapeHtml(content)}</i>`;
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    const char = remaining[0] as string;
    result += escapeHtml(char);
    remaining = remaining.slice(1);
  }

  return result;
}

function mutedTelegramFooter(text: string): string {
  return `<i>${text}</i>`;
}

/**
 * Build a Telegram response with converted Markdown content + optional footer.
 */
export function buildTelegramResponse(
  markdown: string,
  logsUrl?: string,
  footerText?: string,
): string {
  const content = markdownToTelegramHtml(markdown);
  const footers: string[] = [];

  if (logsUrl) {
    footers.push(
      mutedTelegramFooter(`<a href="${escapeHtml(logsUrl)}">📋 Audit</a>`),
    );
  }
  if (footerText) {
    footers.push(mutedTelegramFooter(footerText));
  }

  if (footers.length === 0) {
    return content;
  }

  return `${content}\n\n${footers.join("\n")}`;
}
