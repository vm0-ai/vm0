import { expect, test } from "vitest";

import indexHtml from "../../../../index.html?raw";
import { readGlobalCss } from "./global-css.ts";

function getViewportDirectives(): string[] {
  const match = /<meta\s+name="viewport"\s+content="([^"]+)"/.exec(indexHtml);
  return (
    match?.[1].split(",").map((directive) => {
      return directive.trim();
    }) ?? []
  );
}

test("Fullscreen content uses iOS safe areas", () => {
  expect(indexHtml).toMatch(
    /<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="black-translucent"\s*\/>/,
  );
  expect(indexHtml).not.toContain('content="default"');

  const viewportDirectives = getViewportDirectives();
  expect(viewportDirectives).toStrictEqual(
    expect.arrayContaining(["viewport-fit=cover"]),
  );
  expect(
    viewportDirectives.some((directive) => {
      return directive.startsWith("interactive-widget=");
    }),
  ).toBeFalsy();

  const globalCss = readGlobalCss();
  expect(globalCss).toMatch(/--sat:\s*env\(safe-area-inset-top,\s*0px\);/);
  expect(globalCss).toMatch(/--sar:\s*env\(safe-area-inset-right,\s*0px\);/);
  expect(globalCss).toMatch(
    /--sab-raw:\s*env\(safe-area-inset-bottom,\s*0px\);/,
  );
  expect(globalCss).toMatch(/--sab:\s*var\(--sab-raw\);/);
  expect(globalCss).toMatch(/--sal:\s*env\(safe-area-inset-left,\s*0px\);/);
  expect(globalCss).toMatch(
    /:root\[data-keyboard-open="true"\]\s*{\s*--sab:\s*0px;\s*}/,
  );
  expect(globalCss).toMatch(/bottom:\s*calc\(-1\s*\*\s*var\(--sab\)\);/);
});

test("The startup skeleton stays centered in the reachable mobile viewport", () => {
  const rule = /#app-bootstrap-skeleton\s*{([^}]*)}/.exec(indexHtml)?.[1];
  const contentRule = /\.app-bootstrap-skeleton__content\s*{([^}]*)}/.exec(
    indexHtml,
  )?.[1];

  expect(indexHtml).toMatch(/--zero-viewport-height:\s*100dvh;/);
  expect(indexHtml).toMatch(/--zero-viewport-height:\s*100lvh;/);
  expect(rule).toBeDefined();
  expect(rule).toMatch(/position:\s*fixed;/);
  expect(rule).toMatch(/inset:\s*0;/);
  expect(rule).not.toMatch(/(?:^|[;\s])(?:min-)?height\s*:/);
  expect(contentRule).toBeDefined();
  expect(contentRule).toMatch(/position:\s*fixed;/);
  expect(contentRule).toMatch(/top:\s*50svh;/);
  expect(contentRule).toMatch(/left:\s*50%;/);
  expect(contentRule).toMatch(/transform:\s*translate\(-50%,\s*-50%\);/);
});

test("The standalone mobile app shell remains stable", () => {
  const globalCss = readGlobalCss();

  expect(globalCss).toMatch(/--zero-viewport-height:\s*100dvh;/);
  expect(globalCss).toMatch(/--zero-viewport-height:\s*100lvh;/);
  expect(globalCss).not.toContain("--zero-keyboard-inset");
  expect(globalCss).not.toContain("--zero-keyboard-viewport-height");
  expect(globalCss).not.toContain("--zero-keyboard-viewport-offset-top");
  expect(globalCss).not.toContain("--zero-viewport-offset-top");
  expect(globalCss).toMatch(
    /html,\s*body,\s*#root\s*{[\s\S]*overflow:\s*hidden;[\s\S]*overscroll-behavior:\s*none;/,
  );
  expect(globalCss).toMatch(
    /#root\s*{[\s\S]*isolation:\s*isolate;[\s\S]*position:\s*fixed;[\s\S]*top:\s*0;[\s\S]*right:\s*0;[\s\S]*left:\s*0;/,
  );
  expect(globalCss).toMatch(
    /#root\s*{[\s\S]*box-sizing:\s*border-box;[\s\S]*background-color:\s*hsl\(var\(--background\)\);[\s\S]*padding:\s*var\(--sat\)\s+var\(--sar\)\s+var\(--sab-raw\)\s+var\(--sal\);/,
  );
  expect(globalCss).toMatch(
    /@media\s*\(display-mode:\s*standalone\)\s*{[\s\S]*#root\s*{\s*position:\s*absolute;\s*overflow-y:\s*hidden;\s*}/,
  );
  expect(globalCss.indexOf("position: absolute;")).toBeGreaterThan(
    globalCss.indexOf("position: fixed;"),
  );
  expect(globalCss).toMatch(
    /\.zero-viewport-shell\s*{[\s\S]*height:\s*100%;[\s\S]*max-height:\s*100%;[\s\S]*overflow:\s*hidden;/,
  );
  expect(globalCss).toMatch(
    /\.zero-fixed-viewport-shell\s*{[\s\S]*height:\s*var\(--zero-viewport-height\);[\s\S]*padding:\s*var\(--sat\)\s+var\(--sar\)\s+var\(--sab\)\s+var\(--sal\);/,
  );
  expect(globalCss).toMatch(
    /\.zero-mobile-fixed-safe-area\s*{[\s\S]*padding:\s*var\(--sat\)\s+var\(--sar\)\s+var\(--sab\)\s+var\(--sal\);/,
  );
  expect(globalCss).toMatch(
    /@media\s*\(display-mode:\s*standalone\)\s*{[\s\S]*\[data-chat-composer\]\s+\.zero-composer\s*{\s*scroll-margin-block-end:\s*16px;\s*}/,
  );
  expect(globalCss).toMatch(
    /#root::after\s*{[\s\S]*height:\s*var\(--zero-keyboard-scroll-reserve,\s*0px\);[\s\S]*pointer-events:\s*none;/,
  );
  expect(globalCss).not.toContain("data-keyboard-inset-page");
  expect(globalCss).not.toMatch(/:root\[data-keyboard-open="true"\]\s+#root/);
});
