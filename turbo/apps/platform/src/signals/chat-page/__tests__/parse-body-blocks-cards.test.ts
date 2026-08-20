import { describe, expect, it } from "vitest";

import { testContext } from "../../__tests__/test-helpers.ts";
import { parseBodyBlocks } from "../parse-body-blocks.ts";

/**
 * Pins how card URLs are recognized inside a message body, ahead of moving the
 * recognition into the markdown tree. The shapes below are the ones the current
 * line scanner treats specially, and every one of them has to keep producing
 * the same card for the same source once the scanner is gone.
 */
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const CONNECTOR_URL = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}`;
const context = testContext();

function shapeOf(content: string): string {
  return parseBodyBlocks(content, { previews: true })
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

  it("leaves a connector-shaped url without an agent id as prose", () => {
    const url = `${window.location.origin}/connectors/github/authorize`;

    expect(shapeOf(url)).toBe(`markdown(${JSON.stringify(url)})`);
  });

  it.each(["https://legacy-site.sites.vm0.io/", "https://okou-site.okou.app/"])(
    "recognizes the production hosted-site URL %s",
    (url) => {
      context.mocks.browser.url("https://app.okou.ai/thread");

      expect(shapeOf(url)).toBe("artifact");
    },
  );

  it("rejects a lookalike Okou hosted-site domain", () => {
    context.mocks.browser.url("https://app.okou.ai/thread");
    const url = "https://okou-site.okou.app.attacker.example/";

    expect(shapeOf(url)).toBe(`markdown(${JSON.stringify(url)})`);
  });

  it("recognizes an Okou CDN artifact without rewriting its URL", () => {
    context.mocks.browser.url("https://app.okou.ai/thread");
    const url = "https://cdn.okou.io/artifacts/user_1/artifact_1/report.pdf";
    const parsed = parseBodyBlocks(url, { previews: true });

    expect(parsed.blocks).toStrictEqual([
      expect.objectContaining({
        type: "artifact",
        descriptor: expect.objectContaining({ url }),
      }),
    ]);
  });
});
