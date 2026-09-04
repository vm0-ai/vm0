import { expect, test } from "vitest";

import { readCssRule, readGlobalCss } from "./global-css.ts";

test("The new-UI user bubble uses the raised gray surface", () => {
  const rule = readCssRule(
    readGlobalCss(),
    "[data-new-ui] .zero-app .zero-chat-bubble-user",
  );

  expect(rule).toMatch(/background-color:\s*hsl\(var\(--gray-200\)\);/);
});

test("New-UI inline code uses the raised gray without filling fenced code", () => {
  const css = readGlobalCss();
  const inlineRule = readCssRule(
    css,
    "[data-new-ui] .wmde-markdown :not(pre) > code,\n[data-new-ui] .wmde-markdown :not(pre) > tt",
  );
  const fencedRule = readCssRule(
    css,
    ".wmde-markdown pre code,\n.wmde-markdown pre tt",
  );

  expect(inlineRule).toMatch(/background-color:\s*hsl\(var\(--gray-200\)\);/);
  expect(fencedRule).toMatch(/background-color:\s*transparent;/);
});
