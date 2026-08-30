import { describe, expect, it } from "vitest";

import { readCssRule, readGlobalCss } from "./global-css.ts";

const BOX_SELECTOR = ".zero-markdown .mermaid-diagram-expand";
const TRIGGER_SELECTOR =
  ".zero-markdown .mermaid-block > .icon-tooltip-trigger";
const IMAGE_SELECTOR = ".zero-markdown .mermaid-diagram-image";
const INSET_CHILDREN_SELECTOR = `${IMAGE_SELECTOR},\n.zero-markdown .mermaid-diagram-pending,\n.zero-markdown .mermaid-diagram-invalid`;

function readPixels(rule: string, pattern: RegExp): number {
  const match = pattern.exec(rule);
  if (!match?.[1]) {
    throw new Error(`Unable to read ${String(pattern)} from ${rule}`);
  }
  return Number(match[1]);
}

describe("mermaid diagram box", () => {
  it("scales a diagram of any ratio into the box instead of clipping it", () => {
    const image = readCssRule(readGlobalCss(), IMAGE_SELECTOR);

    // `object-fit` only letterboxes a diagram once the image has a box to fit
    // into. An absolutely positioned <img> sized `auto` is laid out at its own
    // intrinsic size and ignores the opposite insets, so dropping either of
    // these declarations leaves a tall diagram running past the box and a wide
    // one anchored to the top edge.
    expect(image).toMatch(/width:\s*calc\(100% - \d+px\);/);
    expect(image).toMatch(/height:\s*calc\(100% - \d+px\);/);
    expect(image).toMatch(/object-fit:\s*contain;/);
  });

  it("keeps the fitted size in step with the box padding", () => {
    const globalCss = readGlobalCss();
    const padding = readPixels(
      readCssRule(globalCss, BOX_SELECTOR),
      /padding:\s*(\d+)px;/,
    );
    const inset = readPixels(
      readCssRule(globalCss, INSET_CHILDREN_SELECTOR),
      /inset:\s*(\d+)px;/,
    );
    const removedFromSize = readPixels(
      readCssRule(globalCss, IMAGE_SELECTOR),
      /width:\s*calc\(100% - (\d+)px\);/,
    );

    // The image is placed against the padding box, so its size has to give back
    // the padding on both edges itself. A padding change that misses the `calc`
    // would push the diagram back out of the box.
    expect(inset).toBe(padding);
    expect(removedFromSize).toBe(padding * 2);
  });

  it("reserves the same box for every diagram before it renders", () => {
    const globalCss = readGlobalCss();
    const box = readCssRule(globalCss, BOX_SELECTOR);
    const trigger = readCssRule(globalCss, TRIGGER_SELECTOR);

    expect(box).toMatch(/max-width:\s*420px;/);
    expect(box).toMatch(/aspect-ratio:\s*4 \/ 3;/);
    expect(box).toMatch(/overflow:\s*hidden;/);
    expect(trigger).toMatch(/display:\s*block;/);
    expect(trigger).toMatch(/width:\s*100%;/);
    expect(trigger).toMatch(/max-width:\s*420px;/);
    expect(readCssRule(globalCss, INSET_CHILDREN_SELECTOR)).toMatch(
      /position:\s*absolute;/,
    );
  });
});
