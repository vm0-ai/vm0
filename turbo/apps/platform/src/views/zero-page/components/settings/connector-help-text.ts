// Only intended for trusted, source-controlled help text from
// `CONNECTOR_TYPES[*].authMethods.*.helpText`. Do NOT feed user-supplied
// strings into this renderer - the `[text]`, `**bold**`, and `> quote`
// captures are verbatim-injected and would permit HTML smuggling.
export function renderConnectorHelpMarkdown(text: string): string {
  return text
    .replace(
      // Only http(s) URLs are turned into anchors; other schemes fall through
      // as literal text. `"` is also excluded from the href charclass so a
      // stray quote cannot break out of the href attribute and inject
      // siblings like `onclick` when feeding `dangerouslySetInnerHTML`.
      /\[([^\]]+)\]\((https?:\/\/[^)"]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary underline">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(
      /^> (.+)$/gm,
      '<div class="pl-3 border-l-2 border-muted text-muted-foreground">$1</div>',
    );
}
