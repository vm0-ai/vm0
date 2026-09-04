import { expect, test } from "vitest";

import { readCssRule, readGlobalCss } from "./global-css.ts";

test("A desktop workspace card keeps rounded corners over opaque page content", () => {
  const css = readGlobalCss();
  const cardRule = readCssRule(css, "[data-new-ui] .zero-workspace-card");
  const fillRule = readCssRule(
    css,
    "[data-new-ui] .zero-workspace-card.zero-workspace-bg::before",
  );
  const frameRule = readCssRule(
    css,
    "[data-new-ui] .zero-workspace-card.zero-workspace-bg::after",
  );

  expect(css).toMatch(
    /@media\s*\(min-width:\s*48rem\)\s*{\s*\[data-new-ui\]\s+\.zero-workspace-card\s*{/,
  );
  expect(cardRule).toMatch(/--zero-workspace-card-gap:\s*8px;/);
  expect(cardRule).toMatch(/--zero-workspace-card-radius:\s*12px;/);
  expect(cardRule).toMatch(/padding:\s*var\(--zero-workspace-card-gap\);/);

  expect(fillRule).toMatch(/inset:\s*var\(--zero-workspace-card-gap\);/);
  expect(fillRule).toMatch(
    /border-radius:\s*var\(--zero-workspace-card-radius\);/,
  );
  expect(fillRule).not.toMatch(/(?:^|;)\s*border\s*:/);

  expect(frameRule).toMatch(/content:\s*"";/);
  expect(frameRule).toMatch(/position:\s*absolute;/);
  expect(frameRule).toMatch(/inset:\s*var\(--zero-workspace-card-gap\);/);
  expect(frameRule).toMatch(
    /border:\s*0\.7px\s+solid\s+hsl\(var\(--border\)\);/,
  );
  expect(frameRule).toMatch(
    /border-radius:\s*var\(--zero-workspace-card-radius\);/,
  );
  expect(frameRule).toMatch(
    /box-shadow:\s*0\s+0\s+0\s+var\(--zero-workspace-card-gap\)\s+hsl\(var\(--sidebar\)\);/,
  );
  expect(frameRule).toMatch(/pointer-events:\s*none;/);
});
