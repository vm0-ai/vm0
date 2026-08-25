import { describe, expect, it } from "vitest";

import { parseBodyBlocks } from "../parse-body-blocks.ts";

/**
 * Pins how card URLs are recognized inside a message body, ahead of moving the
 * recognition into the markdown tree. The shapes below are the ones the current
 * line scanner treats specially, and every one of them has to keep producing
 * the same card for the same source once the scanner is gone.
 */
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "e4000000-0000-4000-a000-000000000001";
const CONNECTOR_URL = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}`;
const BANKING_URL = `${window.location.origin}/agents/${AGENT_ID}/banking?reason=Review+recent+expenses&threadId=${THREAD_ID}&callbackPrompt=Continue+the+expense+review`;

function shapeOf(content: string): string {
  return parseBodyBlocks(content, {
    previews: true,
    chatActionContext: { agentId: AGENT_ID, threadId: THREAD_ID },
  })
    .blocks.map((block) => {
      return block.type === "markdown"
        ? `markdown(${JSON.stringify(block.content)})`
        : block.type;
    })
    .join(" | ");
}

describe("card recognition in a message body", () => {
  it("turns a standalone connector link into a card with no prose left", () => {
    expect(shapeOf(CONNECTOR_URL)).toBe("connector-action");
  });

  it("keeps the label as prose when a connector link sits inside a sentence", () => {
    const shape = shapeOf(`Please [connect GitHub](${CONNECTOR_URL}) first.`);

    expect(shape).toBe(
      'markdown("Please connect GitHub first.") | connector-action',
    );
  });

  it("leaves a connector link inside a fenced block alone", () => {
    expect(shapeOf(`\`\`\`\n${CONNECTOR_URL}\n\`\`\``)).toBe(
      `markdown(${JSON.stringify(`\`\`\`\n${CONNECTOR_URL}\n\`\`\``)})`,
    );
  });

  it("splits prose around a card today", () => {
    const shape = shapeOf(`before\n\n${CONNECTOR_URL}\n\nafter`);

    expect(shape).toBe(
      'markdown("before") | connector-action | markdown("after")',
    );
  });

  it("leaves an unrecognized url as prose", () => {
    expect(shapeOf("see https://example.com/nothing-special for details")).toBe(
      'markdown("see https://example.com/nothing-special for details")',
    );
  });

  it("makes a connector-shaped url without an agent id unavailable", () => {
    const url = `${window.location.origin}/connectors/github/authorize`;

    expect(shapeOf(url)).toBe("unavailable-action");
  });

  it("turns a current-chat banking request into a banking card", () => {
    expect(shapeOf(BANKING_URL)).toBe("banking-action");
  });

  it("makes banking requests without a purpose unavailable", () => {
    const url = `${window.location.origin}/agents/${AGENT_ID}/banking?threadId=${THREAD_ID}&callbackPrompt=Continue`;

    expect(shapeOf(url)).toBe("unavailable-action");
  });
});
