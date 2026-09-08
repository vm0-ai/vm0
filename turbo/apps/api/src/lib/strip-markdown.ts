/**
 * Remove the Markdown syntax a model tends to emit even when asked for plain
 * text. Shared by every surface that renders generated text unstyled: chat
 * titles, run summaries, and goal objective briefs.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^["'](.+)["']$/, "$1")
    .trim();
}
