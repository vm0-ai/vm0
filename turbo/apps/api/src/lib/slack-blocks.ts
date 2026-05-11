import type { Block, KnownBlock } from "@slack/web-api";

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
