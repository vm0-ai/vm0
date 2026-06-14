import { existsSync, readFileSync } from "node:fs";
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
  const candidates = [
    join(process.cwd(), "src/views/css/index.css"),
    join(process.cwd(), "apps/platform/src/views/css/index.css"),
  ];
  const path = candidates.find((candidate) => {
    return existsSync(candidate);
  });
  if (path === undefined) {
    throw new Error("Unable to locate platform global CSS");
  }
  return readFileSync(path, "utf8");
}

describe("platform entrypoint safe area behavior", () => {
  it("keeps the viewport hints needed for iOS keyboard resizing", () => {
    expect(getViewportDirectives()).toStrictEqual(
      expect.arrayContaining([
        "viewport-fit=cover",
        "interactive-widget=resizes-content",
      ]),
    );

    expect(indexHtml).toMatch(/--zero-viewport-height:\s*100dvh;/);
    expect(indexHtml).toMatch(/--zero-viewport-height:\s*100lvh;/);
    expect(indexHtml).toMatch(
      /\.sk\s*{[\s\S]*height:\s*var\(--zero-viewport-height\);/,
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

  it("keeps the app shell out of page-level scrolling in standalone PWA mode", () => {
    const globalCss = readGlobalCss();

    expect(globalCss).toMatch(/--zero-viewport-height:\s*100dvh;/);
    expect(globalCss).toMatch(/--zero-viewport-height:\s*100lvh;/);
    expect(globalCss).toMatch(
      /:root:has\([\s\S]*:focus-visible[\s\S]*\)\s*{\s*--zero-viewport-height:\s*100dvh;\s*}/,
    );
    expect(globalCss).toMatch(
      /html,\s*body,\s*#root\s*{[\s\S]*overflow:\s*hidden;[\s\S]*overscroll-behavior:\s*none;/,
    );
    expect(globalCss).toMatch(
      /#root\s*{[\s\S]*position:\s*fixed;[\s\S]*top:\s*0;[\s\S]*right:\s*0;[\s\S]*left:\s*0;/,
    );
    expect(globalCss).toMatch(
      /\.zero-viewport-shell\s*{[\s\S]*height:\s*var\(--zero-viewport-height\);[\s\S]*max-height:\s*var\(--zero-viewport-height\);[\s\S]*overflow:\s*hidden;/,
    );
  });
});
