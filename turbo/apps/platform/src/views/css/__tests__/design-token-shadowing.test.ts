import { expect, test } from "vitest";

import { readGlobalCss, readUiGlobalCss } from "./global-css.ts";

function declaredColorTokens(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--color-[a-z0-9-]+)\s*:/gu)) {
    names.add(match[1]);
  }
  return names;
}

test("Platform colors stay consistent with the shared design system", () => {
  const sharedTokens = declaredColorTokens(readUiGlobalCss());
  const platformTokens = declaredColorTokens(readGlobalCss());
  const shadowedTokens = [...platformTokens]
    .filter((token) => {
      return sharedTokens.has(token);
    })
    .sort();
  const interactionStateTokens = [...platformTokens].filter((token) => {
    return token.startsWith("--color-state-");
  });

  expect(shadowedTokens).toStrictEqual(["--color-sidebar"]);
  expect(interactionStateTokens).toStrictEqual([]);
});
