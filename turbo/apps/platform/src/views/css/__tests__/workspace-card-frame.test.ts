import { describe, expect, it } from "vitest";

import { readCssRule, readGlobalCss } from "./global-css.ts";

const globalCss = readGlobalCss();

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
    const frame = readCssRule(globalCss, FRAME);

    expect(frame).toMatch(/border:\s*0\.7px solid hsl\(var\(--border\)\);/);
    expect(frame).toMatch(
      /border-radius:\s*var\(--zero-workspace-card-radius\);/,
    );
    // Without this the frame would swallow clicks across the whole card.
    expect(frame).toMatch(/pointer-events:\s*none;/);
  });

  it("repaints only the gutter the card's own padding already reserves", () => {
    const frame = readCssRule(globalCss, FRAME);

    // Spread equal to the gap is what bounds the overpaint to the corner
    // triangles the radius cuts away; a larger spread would eat real content.
    expect(frame).toMatch(
      /box-shadow:\s*0 0 0 var\(--zero-workspace-card-gap\) hsl\(var\(--sidebar\)\);/,
    );
    expect(frame).toMatch(/inset:\s*var\(--zero-workspace-card-gap\);/);
    expect(readCssRule(globalCss, CARD)).toMatch(
      /padding:\s*var\(--zero-workspace-card-gap\);/,
    );
  });

  it("keeps the fill and the frame on one radius", () => {
    expect(readCssRule(globalCss, CARD)).toMatch(
      /--zero-workspace-card-radius:\s*\d+px;/,
    );
    for (const selector of [FILL, FRAME]) {
      expect(readCssRule(globalCss, selector)).toMatch(
        /border-radius:\s*var\(--zero-workspace-card-radius\);/,
      );
    }
  });

  // Two stacked 0.7px strokes read heavier than one, and the fill's stroke only
  // survives where content is transparent -- so sharing the border between the
  // two made the top corners half again as heavy as the bottom ones.
  it("leaves the border to the frame alone so no edge is drawn twice", () => {
    expect(readCssRule(globalCss, FILL)).not.toMatch(/border:\s/);
  });
});
