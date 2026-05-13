/**
 * Convert Markdown to a plain-text form suited to iMessage / SMS delivery.
 *
 * iMessage has no markup parser, so markers like `**bold**` or `[text](url)`
 * arrive as literal characters. This strips the markers and reformats links
 * so the URL sits on its own line, which is what triggers iMessage's rich
 * link preview.
 *
 * Supported transformations:
 * - `**bold**` / `__bold__` → `bold`
 * - `*italic*` / `_italic_` → `italic`
 * - `` `code` `` → `code`
 * - ` ```lang\nblock\n``` ` → `block` (fence markers stripped)
 * - `~~strike~~` → `strike`
 * - `# Heading` (any depth) → `Heading`
 * - `- item` / `* item` → `• item`
 * - `> quote` → `quote`
 * - `[text](url)` → `text\nurl` (so the URL stands alone and previews)
 * - `![alt](url)` → `alt\nurl`
 */
export function markdownToImessagePlain(markdown: string): string {
  if (markdown.length === 0) return markdown;

  let text = markdown;

  // Fenced code blocks: drop the ``` markers, keep the content as-is.
  text = text.replace(
    /```[^\n]*\n?([\s\S]*?)\n?```/g,
    (_match, content: string) => {
      return content;
    },
  );

  // Images: ![alt](url) → "alt\nurl" (or just url when alt is empty).
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, alt: string, url: string) => {
      const label = alt.trim();
      return label ? `${label}\n${url}` : url;
    },
  );

  // Links: [text](url) → "text\nurl" so iMessage renders a rich preview.
  // When the link label is identical to the URL, emit the URL once.
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, label: string, url: string) => {
      const trimmed = label.trim();
      if (!trimmed || trimmed === url) return url;
      return `${trimmed}\n${url}`;
    },
  );

  // Bold before italic so ** doesn't get eaten by the single-asterisk pass.
  text = text.replace(/\*\*([^\n*]+)\*\*/g, "$1");
  text = text.replace(/__([^\n_]+)__/g, "$1");

  // Italic: *text* and _text_ without surrounding word characters for _.
  text = text.replace(/\*([^\n*]+)\*/g, "$1");
  text = text.replace(/(^|[^A-Za-z0-9_])_([^\n_]+)_(?![A-Za-z0-9_])/g, "$1$2");

  // Inline code.
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // Strikethrough.
  text = text.replace(/~~([^\n~]+)~~/g, "$1");

  // ATX headings (up to 6 #).
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");

  // Setext headings: drop the underline rows that follow a heading line.
  text = text.replace(/^(.+)\n[=-]{2,}[ \t]*$/gm, "$1");

  // Unordered list markers.
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");

  // Blockquote markers.
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");

  // Collapse runs of blank lines so the message doesn't bloat.
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
