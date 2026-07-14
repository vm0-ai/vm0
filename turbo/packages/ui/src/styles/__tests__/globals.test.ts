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

describe("global focus colors", () => {
  it("sets native outlines to the semantic focus color before focus", () => {
    expect(globalCss).toMatch(
      /\*\s*{[\s\S]*?outline-color:\s*hsl\(var\(--ring\)\);[\s\S]*?}/,
    );
  });

  it("resolves the focus color from each theme's primary scale", () => {
    expect(globalCss).toMatch(
      /:root\s*{[\s\S]*?--primary-600:\s*15 80% 66%;[\s\S]*?--ring:\s*var\(--primary-600\);/,
    );
    expect(globalCss).toMatch(
      /\[data-theme="dark"\]\s*{[\s\S]*?--primary-600:\s*16 62% 41%;[\s\S]*?--ring:\s*var\(--primary-600\);/,
    );
  });
});
