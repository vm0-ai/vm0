type ArtifactMarkdownOutput = {
  readonly inlineMarkdownLink: string;
  readonly previewMarkdownBlock: string;
};

function escapeMarkdownLabel(label: string): string {
  return label
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\\/gu, String.raw`\\`)
    .replace(/\[/gu, String.raw`\[`)
    .replace(/\]/gu, String.raw`\]`);
}

export function createArtifactMarkdownOutput(
  label: string,
  url: string,
): ArtifactMarkdownOutput {
  const escapedLabel = escapeMarkdownLabel(label);
  return {
    inlineMarkdownLink: `[${escapedLabel}](<${url}>)`,
    previewMarkdownBlock: `![${escapedLabel}](<${url}>)`,
  };
}

export function formatArtifactPresentationContext(
  output: ArtifactMarkdownOutput,
): string {
  return [
    "Artifact presentation context:",
    "",
    "Inline Markdown link:",
    output.inlineMarkdownLink,
    "This form remains a link in normal prose.",
    "",
    "Rich preview Markdown:",
    "",
    output.previewMarkdownBlock,
    "",
    "The rich-preview form is displayed as a standalone preview when it occupies its own Markdown paragraph, with a blank line before and after it, and is outside a code fence.",
    "",
    "Both forms reference the same artifact. Including both in one response creates two user-facing references.",
  ].join("\n");
}
