function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInlineConnectorHelpMarkdown(text: string): string {
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)"\s]+)\)/g;
  let rendered = "";
  let lastIndex = 0;

  for (const match of text.matchAll(linkPattern)) {
    rendered += renderBoldConnectorHelpMarkdown(
      text.slice(lastIndex, match.index),
    );
    rendered += `<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer" class="text-primary underline">${renderBoldConnectorHelpMarkdown(match[1])}</a>`;
    lastIndex = match.index + match[0].length;
  }

  rendered += renderBoldConnectorHelpMarkdown(text.slice(lastIndex));
  return rendered;
}

function renderBoldConnectorHelpMarkdown(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function renderConnectorHelpMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) {
        return `<div class="pl-3 border-l-2 border-muted text-muted-foreground">${renderInlineConnectorHelpMarkdown(line.slice(2))}</div>`;
      }
      return renderInlineConnectorHelpMarkdown(line);
    })
    .join("\n");
}
