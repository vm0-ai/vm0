import type { Block, KnownBlock, MarkdownBlock } from "@slack/web-api";

const MARKDOWN_BLOCK_MAX_LENGTH = 12_000;

function buildMarkdownMessage(content: string): (Block | KnownBlock)[] {
  const truncationSuffix = "\n\n_(Message too long to view in Slack.)_";
  const truncated =
    content.length > MARKDOWN_BLOCK_MAX_LENGTH
      ? content.substring(
          0,
          MARKDOWN_BLOCK_MAX_LENGTH - truncationSuffix.length,
        ) + truncationSuffix
      : content;

  const block: MarkdownBlock = {
    type: "markdown",
    text: truncated,
  };

  return [block];
}

export function buildAgentResponseMessage(
  content: string,
  logsUrl?: string,
  footerText?: string,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [...buildMarkdownMessage(content)];

  if (logsUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:clipboard: <${logsUrl}|Audit>`,
        },
      ],
    });
  }

  if (footerText) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: footerText,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build a divider + context block pair for message footers.
 */
export function buildFooterBlocks(text: string): (Block | KnownBlock)[] {
  return [
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text,
        },
      ],
    },
  ];
}
