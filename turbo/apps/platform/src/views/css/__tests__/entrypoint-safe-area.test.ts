import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import indexHtml from "../../../../index.html?raw";

function getViewportDirectives(): string[] {
  const match = /<meta\s+name="viewport"\s+content="([^"]+)"/.exec(indexHtml);
  return (
    match?.[1].split(",").map((directive) => {
      return directive.trim();
    }) ?? []
  );
}

function readGlobalCss(): string {
  return readFileSync(
    join(process.cwd(), "apps/platform/src/views/css/index.css"),
    "utf8",
  );
}

describe("platform entrypoint safe area behavior", () => {
  it("keeps the viewport hints needed for iOS keyboard resizing", () => {
    expect(getViewportDirectives()).toStrictEqual(
      expect.arrayContaining([
        "viewport-fit=cover",
        "interactive-widget=resizes-content",
      ]),
    );
  });

  it("suppresses the bottom safe-area inset while text entry is focused", () => {
    const globalCss = readGlobalCss();

    expect(globalCss).toMatch(
      /--sab-raw:\s*env\(safe-area-inset-bottom,\s*0px\);/,
    );
    expect(globalCss).toMatch(/--sab:\s*var\(--sab-raw\);/);
    expect(globalCss).toMatch(
      /:root:has\([\s\S]*:focus-visible[\s\S]*\)\s*{\s*--sab:\s*0px;\s*}/,
    );
    expect(globalCss).toMatch(/bottom:\s*calc\(-1\s*\*\s*var\(--sab\)\);/);
  });
});
