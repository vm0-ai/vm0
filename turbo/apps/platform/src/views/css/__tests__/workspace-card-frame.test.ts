import { describe, expect, it } from "vitest";

import { readGlobalCss } from "./global-css.ts";

const globalCss = readGlobalCss();

/** Returns the declaration body of the first rule introduced by `selector`. */
function readRuleBody(selector: string): string {
  const start = globalCss.indexOf(selector);
  if (start === -1) {
    throw new Error(`Unable to locate CSS rule for ${selector}`);
  }
  const open = globalCss.indexOf("{", start);
  const close = globalCss.indexOf("}", open);
  if (close === -1) {
    throw new Error(`Unterminated CSS rule for ${selector}`);
  }
  return globalCss.slice(open + 1, close);
}

const CARD = "[data-new-ui] .zero-workspace-card";
const FILL = `${CARD}.zero-workspace-bg::before`;
const FRAME = `${CARD}.zero-workspace-bg::after`;

// The fill paints behind content, so on its own the card's rounded corners
// survive only where content is transparent. A page whose last child is flush
// with the content box and carries its own opaque background -- the chat
// composer footer is one -- squared off the two bottom corners and took the
// bottom border with them.
describe("new UI workspace card frame", () => {
  it("restates the border over content so flush children cannot bury it", () => {
    const frame = readRuleBody(FRAME);

    expect(frame).toMatch(/border:\s*0\.7px solid hsl\(var\(--border\)\);/);
    expect(frame).toMatch(
      /border-radius:\s*var\(--zero-workspace-card-radius\);/,
    );
    // Without this the frame would swallow clicks across the whole card.
    expect(frame).toMatch(/pointer-events:\s*none;/);
  });

  it("repaints only the gutter the card's own padding already reserves", () => {
    const card = readRuleBody(CARD);
    const frame = readRuleBody(FRAME);

    // Spread equal to the gap is what bounds the overpaint to the corner
    // triangles the radius cuts away; a larger spread would eat real content.
    expect(frame).toMatch(
      /box-shadow:\s*0 0 0 var\(--zero-workspace-card-gap\) hsl\(var\(--sidebar\)\);/,
    );
    expect(frame).toMatch(/inset:\s*var\(--zero-workspace-card-gap\);/);
    expect(card).toMatch(/padding:\s*var\(--zero-workspace-card-gap\);/);
  });

  it("keeps the fill and the frame on one radius", () => {
    expect(readRuleBody(CARD)).toMatch(
      /--zero-workspace-card-radius:\s*\d+px;/,
    );
    for (const selector of [FILL, FRAME]) {
      expect(readRuleBody(selector)).toMatch(
        /border-radius:\s*var\(--zero-workspace-card-radius\);/,
      );
    }
  });
});
