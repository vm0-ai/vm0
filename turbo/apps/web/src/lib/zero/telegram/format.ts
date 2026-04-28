/** Maximum message length allowed by Telegram */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Escape HTML special characters for Telegram HTML parse mode
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
 * Supported conversions:
 * - `**bold**` → `<b>bold</b>`
 * - `*italic*` → `<i>italic</i>`
 * - `` `code` `` → `<code>code</code>`
 * - ` ```lang\nblock\n``` ` → `<pre>block</pre>`
 * - `[text](url)` → `<a href="url">text</a>`
 */
export function markdownToTelegramHtml(markdown: string): string {
  let result = "";
  let remaining = markdown;

  while (remaining.length > 0) {
    // Fenced code blocks: ```lang?\n...\n```
    const codeBlockMatch = remaining.match(/^```[^\n]*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      const content = codeBlockMatch[1] as string;
      result += `<pre>${escapeHtml(content)}</pre>`;
      remaining = remaining.slice(codeBlockMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const inlineCodeMatch = remaining.match(/^`([^`]+)`/);
    if (inlineCodeMatch) {
      const content = inlineCodeMatch[1] as string;
      result += `<code>${escapeHtml(content)}</code>`;
      remaining = remaining.slice(inlineCodeMatch[0].length);
      continue;
    }

    // Images: ![alt](url) → clickable link (Telegram doesn't support inline images)
    const imageMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      const altText = (imageMatch[1] as string) || "image";
      const imageUrl = imageMatch[2] as string;
      result += `<a href="${escapeHtml(imageUrl)}">🖼 ${escapeHtml(altText)}</a>`;
      remaining = remaining.slice(imageMatch[0].length);
      continue;
    }

    // Links: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const linkText = linkMatch[1] as string;
      const linkUrl = linkMatch[2] as string;
      result += `<a href="${escapeHtml(linkUrl)}">${escapeHtml(linkText)}</a>`;
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Bold: **text**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      const content = boldMatch[1] as string;
      result += `<b>${escapeHtml(content)}</b>`;
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *text* (but not **)
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      const content = italicMatch[1] as string;
      result += `<i>${escapeHtml(content)}</i>`;
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Escape HTML entities in plain text, one char at a time
    const char = remaining[0] as string;
    result += escapeHtml(char);
    remaining = remaining.slice(1);
  }

  return result;
}

/**
 * Build a structured Telegram response with converted content and audit footer.
 */
export function buildTelegramResponse(
  markdown: string,
  logsUrl?: string,
): string {
  const content = markdownToTelegramHtml(markdown);
  if (!logsUrl) {
    return content;
  }

  const footer = `<a href="${escapeHtml(logsUrl)}">📋 Audit</a>`;

  return `${content}\n\n${footer}`;
}

/**
 * Build a structured error response for Telegram.
 *
 * Format:
 *   ❌ Agent Execution Error
 *
 *   <error detail>
 *
 *   📋 View logs
 */
export function buildTelegramErrorResponse(
  errorDetail: string,
  logsUrl?: string,
): string {
  const header = `❌ <b>Agent Execution Error</b>`;
  const content = escapeHtml(errorDetail);
  if (!logsUrl) {
    return `${header}\n\n${content}`;
  }

  const footer = `<a href="${escapeHtml(logsUrl)}">📋 View logs</a>`;
  return `${header}\n\n${content}\n\n${footer}`;
}

/**
 * Split a message into chunks that fit within Telegram's message length limit.
 *
 * Splitting priority:
 * 1. Paragraph boundaries (`\n\n`)
 * 2. Line boundaries (`\n`)
 * 3. Hard cut at maxLength
 *
 * Never breaks code blocks mid-block.
 */
export function splitMessage(
  text: string,
  maxLength: number = MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.slice(0, maxLength);

    // Check if we're inside a code block — don't split mid-block
    const codeBlockOpens = (window.match(/```/g) ?? []).length;
    if (codeBlockOpens % 2 !== 0) {
      // Odd number of ``` means we'd split inside a code block
      const lastOpenIndex = window.lastIndexOf("```");
      if (lastOpenIndex > 0) {
        // Split before the code block starts
        chunks.push(remaining.slice(0, lastOpenIndex).trimEnd());
        remaining = remaining.slice(lastOpenIndex);
        continue;
      }
      // Code block starts at position 0 and exceeds maxLength —
      // find the closing ``` and include the whole block
      const closingIndex = remaining.indexOf("```", 3);
      if (closingIndex !== -1) {
        const endIndex = closingIndex + 3;
        chunks.push(remaining.slice(0, endIndex));
        remaining = remaining.slice(endIndex).replace(/^\n/, "");
        continue;
      }
    }

    // Try to split at paragraph boundary
    const lastParagraph = window.lastIndexOf("\n\n");
    if (lastParagraph > maxLength / 4) {
      chunks.push(remaining.slice(0, lastParagraph).trimEnd());
      remaining = remaining.slice(lastParagraph + 2);
      continue;
    }

    // Try to split at line boundary
    const lastNewline = window.lastIndexOf("\n");
    if (lastNewline > maxLength / 4) {
      chunks.push(remaining.slice(0, lastNewline).trimEnd());
      remaining = remaining.slice(lastNewline + 1);
      continue;
    }

    // Hard cut
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  return chunks;
}
