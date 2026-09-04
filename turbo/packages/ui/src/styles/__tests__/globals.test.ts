/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function readGlobalCss(): string {
  const candidates = [
    join(process.cwd(), "src/styles/globals.css"),
    join(process.cwd(), "packages/ui/src/styles/globals.css"),
  ];
  const path = candidates.find((candidate) => {
    return existsSync(candidate);
  });
  if (path === undefined) {
    throw new Error("Unable to locate UI global CSS");
  }
  return readFileSync(path, "utf8");
}

const globalCss = readGlobalCss();

/** Returns the declaration body of the first rule introduced by `selector`. */
function readRuleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) {
    throw new Error(`Unable to locate CSS rule for ${selector}`);
  }
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") {
      depth += 1;
      continue;
    }
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, index);
      }
    }
  }
  throw new Error(`Unterminated CSS rule for ${selector}`);
}

/** Maps each `--state-<step>-alpha` declaration in `themeBody` to its percent. */
function readAlphas(themeBody: string): Map<string, number> {
  const alphas = new Map<string, number>();
  for (const [, step, percent] of themeBody.matchAll(
    /--state-([a-z-]+)-alpha:\s*([\d.]+)%/g,
  )) {
    if (step !== undefined && percent !== undefined) {
      alphas.set(step, Number(percent));
    }
  }
  return alphas;
}

function readAlpha(themeBody: string, name: string): number {
  const alpha = readAlphas(themeBody).get(name);
  if (alpha === undefined) {
    throw new Error(`Missing --state-${name}-alpha`);
  }
  return alpha;
}

const THEMES = [
  { name: "light", selector: ":root" },
  { name: "dark", selector: '[data-theme="dark"]' },
];

describe("global focus colors", () => {
  it("sets native outlines to the semantic focus color before focus", () => {
    expect(globalCss).toMatch(
      /\*\s*{[\s\S]*?outline-color:\s*hsl\(var\(--ring\)\);[\s\S]*?}/,
    );
  });

  it.each(THEMES)(
    "resolves $name's focus color from the primary scale",
    ({ selector }) => {
      const theme = readRuleBody(globalCss, selector);
      const ring = /--ring:\s*var\(--(primary-\d+)\);/.exec(theme);

      expect(ring).not.toBeNull();
      // The stop each theme reaches for is a design choice and moves with the
      // palette; what must hold is that it is a stop, not a loose literal.
      const declaration = theme
        .split("\n")
        .find((line) => {
          return line.trimStart().startsWith(`--${ring?.[1] ?? ""}:`);
        })
        ?.trim();

      expect(declaration).toMatch(/^--primary-\d+:\s*[\d.]+ [\d.]+% [\d.]+%;/);
    },
  );
});

describe("global Lucide defaults", () => {
  it("preserves explicit stroke widths while normalizing Lucide's default", () => {
    const selector =
      'svg[class*="lucide"][stroke-width="2"]:not([data-stroke])';

    expect(readRuleBody(globalCss, selector)).toMatch(
      /stroke-width:\s*var\(--icon-stroke-width\);/,
    );
  });

  it("renders more icons as solid dots", () => {
    const selector =
      "svg.lucide-ellipsis circle,\n  svg.lucide-ellipsis-vertical circle";

    expect(readRuleBody(globalCss, selector)).toMatch(/fill:\s*currentColor;/);
  });
});

describe("dialog transitions", () => {
  it("does not apply exit styles while a remounted dialog is open", () => {
    expect(
      readRuleBody(
        globalCss,
        ".zero-dialog-overlay[data-ending-style]:not([data-open])",
      ),
    ).toMatch(/animation:\s*zero-dialog-overlay-out/);
    expect(
      readRuleBody(
        globalCss,
        ".zero-dialog-overlay[data-ending-style]:not([data-open])::after",
      ),
    ).toMatch(/visibility:\s*hidden/);
    expect(
      readRuleBody(
        globalCss,
        ".zero-dialog-content[data-ending-style]:not([data-open])",
      ),
    ).toMatch(/animation:\s*zero-dialog-content-out/);
  });
});

describe("interaction state ladder", () => {
  it.each(THEMES)(
    "gives $name a layer colour and every alpha",
    ({ selector }) => {
      const theme = readRuleBody(globalCss, selector);

      expect(theme).toMatch(/--state-layer:\s*[\d.]+ [\d.]+% [\d.]+%;/);
      for (const name of [
        "hover",
        "selected",
        "selected-hover",
        "pressed",
        "on-filled-hover",
        "on-filled-pressed",
      ]) {
        expect(() => {
          return readAlpha(theme, name);
        }).not.toThrow();
      }
    },
  );

  // The ordering defect this ladder replaces let an unselected row outweigh the
  // selected one. Pin the ladder so a future tweak cannot reintroduce it.
  it.each(THEMES)(
    "keeps $name's neutral states strictly increasing",
    ({ selector }) => {
      const theme = readRuleBody(globalCss, selector);

      const hover = readAlpha(theme, "hover");
      const selected = readAlpha(theme, "selected");
      const selectedHover = readAlpha(theme, "selected-hover");
      const pressed = readAlpha(theme, "pressed");

      expect(hover).toBeLessThan(selected);
      expect(selected).toBeLessThan(selectedHover);
      expect(selectedHover).toBeLessThan(pressed);
    },
  );

  it.each(THEMES)(
    "keeps $name's filled states strictly increasing",
    ({ selector }) => {
      const theme = readRuleBody(globalCss, selector);

      expect(readAlpha(theme, "on-filled-hover")).toBeLessThan(
        readAlpha(theme, "on-filled-pressed"),
      );
    },
  );

  // A translucent layer replaces an opaque fill instead of sitting on it, so
  // every surface that carries one needs a pre-mixed pair derived from the
  // same alphas.
  it.each(["card", "input", "secondary", "primary", "destructive"])(
    "derives %s's hover from the shared state alphas",
    (surface) => {
      expect(globalCss).toContain(`--color-${surface}-hover: color-mix(`);
    },
  );
});

// The segment control is only legible when its track separates from the page
// and the white selection separates from the track. Under the new palette both
// gaps ran through `--muted`'s gray-100, which clears 1.06:1 against white, so
// the whole control dissolved. The track owns its own token now.
describe("new UI segment control track", () => {
  it("gives the track a token the base theme resolves to muted", () => {
    expect(globalCss).toContain(
      "--color-segment-track: hsl(var(--segment-track));",
    );
    expect(readRuleBody(globalCss, "  :root")).toMatch(
      /--segment-track:\s*var\(--muted\);/,
    );
  });

  it("steps the light track off muted so the control separates from the page", () => {
    expect(readRuleBody(globalCss, ":root[data-new-ui]")).toMatch(
      /--segment-track:\s*var\(--gray-200\);/,
    );
  });

  // Chrome keeps the ramp's warm Ink; only content goes neutral, so the two nav
  // columns must not follow the body copy off `--gray-950`.
  it("keeps body copy neutral while the sidebar stays on Ink", () => {
    const newUiLight = readRuleBody(globalCss, ":root[data-new-ui]");

    expect(newUiLight).toMatch(/--foreground:\s*0 0% 14\.1%;/);
    expect(newUiLight).toMatch(/--sidebar-foreground:\s*var\(--gray-950\);/);
  });
});
