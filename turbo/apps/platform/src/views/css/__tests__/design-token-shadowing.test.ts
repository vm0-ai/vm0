import { describe, expect, it } from "vitest";

import { readCssRule, readGlobalCss, readUiGlobalCss } from "./global-css.ts";

/**
 * The platform re-declares `--color-*` names that `@okouai/ui` already defines.
 * Tailwind resolves utilities from `--color-*`, and the platform sheet is
 * imported after the design system's, so each of these wins over the shipped
 * value for the whole web app.
 *
 * That is deliberate for the nav's own surface, and a silent bug everywhere
 * else: a lightened `--color-sidebar-accent` shipped in the design system once
 * stayed dead in production because this file pinned it back to `gray-100`.
 * Keep the list exhaustive so adding a shadow is a decision, not an accident.
 */
function intentionalShadows(): string[] {
  return [
    // The Zero nav sits on its own surface: lighter than the design system's
    // sidebar in light mode, darker in dark mode.
    "--color-sidebar",
    // The nav's brand mark is drawn on that surface rather than filled with it.
    "--color-sidebar-primary",
  ];
}

function declaredColorTokens(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--color-[a-z0-9-]+)\s*:/g)) {
    names.add(match[1]);
  }
  return names;
}

describe("design token shadowing", () => {
  it("only overrides design system colors that are meant to differ", () => {
    const uiTokens = declaredColorTokens(readUiGlobalCss());
    const platformTokens = declaredColorTokens(readGlobalCss());

    const shadowed = [...platformTokens]
      .filter((token) => {
        return uiTokens.has(token);
      })
      .sort();

    expect(shadowed).toStrictEqual(intentionalShadows().sort());
  });

  it("leaves the interaction state ladder to the design system", () => {
    const platformTokens = declaredColorTokens(readGlobalCss());

    const stateTokens = [...platformTokens].filter((token) => {
      return token.startsWith("--color-state-");
    });

    expect(stateTokens).toStrictEqual([]);
  });

  it("keeps the themed navigation hierarchy and hover copy feature-gated", () => {
    const css = readGlobalCss();

    expect(
      readCssRule(css, ".zero-app[data-gradient-color-themes] .zero-nav"),
    ).toContain("--color-sidebar-border: hsl(var(--border) / 0.5)");
    expect(
      readCssRule(
        css,
        ".zero-app[data-gradient-color-themes] .zero-nav .zero-nav-copy",
      ),
    ).toContain("color: hsl(var(--zero-nav-foreground))");
    expect(
      readCssRule(
        css,
        ".zero-app[data-gradient-color-themes] .zero-nav .zero-nav-copy-muted",
      ),
    ).toContain("color: hsl(var(--zero-nav-muted-foreground))");
    expect(css.replace(/\s+/g, " ")).toContain(
      ".zero-app[data-gradient-color-themes] .group:hover .zero-nav-copy-muted-hover { color: hsl(var(--zero-nav-foreground));",
    );
  });
});
