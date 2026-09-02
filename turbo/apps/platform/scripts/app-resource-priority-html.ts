import type { Plugin } from "vite";

const MAIN_STYLESHEET_ID = "vm0-main-stylesheet";
const MAIN_STYLESHEET_LOADER_SCRIPT_ID = "vm0-main-stylesheet-loader";

function matchingTags(
  htmlSource: string,
  tagPattern: RegExp,
  assetPattern: RegExp,
): string[] {
  return [...htmlSource.matchAll(tagPattern)]
    .map((match) => {
      return match[0];
    })
    .filter((tag) => {
      return assetPattern.test(tag);
    });
}

function singleAssetTag(
  htmlSource: string,
  label: string,
  tagPattern: RegExp,
  assetPattern: RegExp,
): string {
  const tags = matchingTags(htmlSource, tagPattern, assetPattern);
  if (tags.length !== 1 || !tags[0]) {
    throw new Error(
      `Expected exactly one generated ${label} tag, but found ${tags.length}`,
    );
  }
  return tags[0];
}

function mainStylesheetPreload(tag: string): string {
  return tag.replace(
    /\srel="stylesheet"/u,
    ` id="${MAIN_STYLESHEET_ID}" rel="preload" as="style"`,
  );
}

function mainStylesheetLoaderScript(): string {
  return `<script id="${MAIN_STYLESHEET_LOADER_SCRIPT_ID}">
      (function () {
        var stylesheet = document.getElementById("${MAIN_STYLESHEET_ID}");
        window.__mainStylesheetLoaded = new Promise(function (resolve) {
          stylesheet.addEventListener(
            "load",
            function () {
              stylesheet.rel = "stylesheet";
              stylesheet.removeAttribute("as");
              requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                  resolve("loaded");
                });
              });
            },
            { once: true },
          );
          stylesheet.addEventListener(
            "error",
            function () {
              resolve("failed");
            },
            { once: true },
          );
        });
      })();
    </script>`;
}

function preloadApplicationStylesheet(htmlSource: string): string {
  const linkTagPattern = /<link\b[^>]*>/gu;
  const stylesheet = singleAssetTag(
    htmlSource,
    "application stylesheet",
    linkTagPattern,
    /\srel="stylesheet"[^>]*\shref="[^"]*\/assets\/index-[^"/]+\.css"/u,
  );
  return htmlSource.replace(
    stylesheet,
    `${mainStylesheetPreload(stylesheet)}\n    ${mainStylesheetLoaderScript()}`,
  );
}

export function applicationResourcePriorityHtmlPlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-application-resource-priority-html",
    transformIndexHtml: {
      order: "post",
      handler(htmlSource) {
        return preloadApplicationStylesheet(htmlSource);
      },
    },
  };
}
