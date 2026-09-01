import type { Plugin } from "vite";

const CRITICAL_STYLE_ID = "app-bootstrap-critical-styles";
const AFTER_FIRST_PAINT_SCRIPT_ID = "vm0-after-first-paint";
const DEFERRED_RESOURCES_SCRIPT_ID = "vm0-deferred-application-resources";

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

function removeTag(htmlSource: string, tag: string): string {
  const firstIndex = htmlSource.indexOf(tag);
  const lastIndex = htmlSource.lastIndexOf(tag);
  if (firstIndex === -1 || firstIndex !== lastIndex) {
    throw new Error("Generated application resource tag is not unique");
  }
  return `${htmlSource.slice(0, firstIndex)}${htmlSource.slice(firstIndex + tag.length)}`;
}

function hrefFromLink(tag: string): string {
  const match = /\shref="([^"]+)"/u.exec(tag);
  if (!match?.[1]) {
    throw new Error(`Generated link tag is missing href: ${tag}`);
  }
  return match[1];
}

function srcFromScript(tag: string): string {
  const match = /\ssrc="([^"]+)"/u.exec(tag);
  if (!match?.[1]) {
    throw new Error(`Generated script tag is missing src: ${tag}`);
  }
  return match[1];
}

function inlineJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("Application resource metadata is not serializable");
  }
  return json.replaceAll("<", String.raw`\u003c`);
}

function afterFirstPaintScript(resources: {
  readonly applicationModule: string;
  readonly modulePreloads: readonly string[];
  readonly stylesheet: string;
}): string {
  return `    <script id="${DEFERRED_RESOURCES_SCRIPT_ID}" type="application/json">${inlineJson(resources)}</script>
    <script id="${AFTER_FIRST_PAINT_SCRIPT_ID}">
      (function () {
        var resourceMetadata = document.getElementById("${DEFERRED_RESOURCES_SCRIPT_ID}");
        if (!resourceMetadata) {
          throw new Error("Deferred application resource metadata is unavailable");
        }
        var resources = JSON.parse(resourceMetadata.textContent);

        function appendModulePreload(source) {
          var preload = document.createElement("link");
          preload.rel = "modulepreload";
          preload.href = source;
          preload.crossOrigin = "anonymous";
          preload.fetchPriority = "low";
          document.head.appendChild(preload);
        }

        function appendApplicationModule() {
          var application = document.createElement("script");
          application.type = "module";
          application.src = resources.applicationModule;
          application.crossOrigin = "anonymous";
          application.fetchPriority = "low";
          document.body.appendChild(application);
        }

        function activateApplicationResources() {
          var stylesheet = document.createElement("link");
          stylesheet.rel = "stylesheet";
          stylesheet.href = resources.stylesheet;
          stylesheet.crossOrigin = "anonymous";
          stylesheet.fetchPriority = "high";
          stylesheet.onload = appendApplicationModule;
          document.head.appendChild(stylesheet);

          appendModulePreload(resources.applicationModule);
          for (var i = 0; i < resources.modulePreloads.length; i += 1) {
            appendModulePreload(resources.modulePreloads[i]);
          }
        }

        var PaintObserver = window.PerformanceObserver;
        if (
          PaintObserver &&
          PaintObserver.supportedEntryTypes &&
          PaintObserver.supportedEntryTypes.indexOf("paint") !== -1
        ) {
          var observer = new PaintObserver(function (entryList) {
            var entries = entryList.getEntries();
            for (var i = 0; i < entries.length; i += 1) {
              if (entries[i].name === "first-contentful-paint") {
                observer.disconnect();
                activateApplicationResources();
                return;
              }
            }
          });
          observer.observe({ type: "paint", buffered: true });
          return;
        }

        requestAnimationFrame(function () {
          requestAnimationFrame(activateApplicationResources);
        });
      })();
    </script>`;
}

function deferApplicationResourcesUntilFirstPaint(htmlSource: string): string {
  const linkTagPattern = /<link\b[^>]*>/gu;
  const scriptTagPattern = /<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/giu;
  const stylesheet = singleAssetTag(
    htmlSource,
    "application stylesheet",
    linkTagPattern,
    /\srel="stylesheet"[^>]*\shref="[^"]*\/assets\/index-[^"/]+\.css"/u,
  );
  const runtimePreload = singleAssetTag(
    htmlSource,
    "runtime module preload",
    linkTagPattern,
    /\srel="modulepreload"[^>]*\shref="[^"]*\/assets\/rolldown-runtime-[^"/]+\.js"/u,
  );
  const vendorPreload = singleAssetTag(
    htmlSource,
    "vendor module preload",
    linkTagPattern,
    /\srel="modulepreload"[^>]*\shref="[^"]*\/assets\/vendor-[^"/]+\.js"/u,
  );
  const applicationModule = singleAssetTag(
    htmlSource,
    "application module",
    scriptTagPattern,
    /\stype="module"[^>]*\ssrc="[^"]*\/assets\/index-[^"/]+\.js"/u,
  );

  let prioritizedHtml = htmlSource;
  for (const tag of [
    stylesheet,
    runtimePreload,
    vendorPreload,
    applicationModule,
  ]) {
    prioritizedHtml = removeTag(prioritizedHtml, tag);
  }

  const criticalStyleOpeningTag = `<style id="${CRITICAL_STYLE_ID}">`;
  const criticalStyleStart = prioritizedHtml.indexOf(criticalStyleOpeningTag);
  if (criticalStyleStart === -1) {
    throw new Error(
      `Expected the critical stylesheet marker #${CRITICAL_STYLE_ID}`,
    );
  }
  const criticalStyleEnd = prioritizedHtml.indexOf(
    "</style>",
    criticalStyleStart,
  );
  if (criticalStyleEnd === -1) {
    throw new Error("Critical application stylesheet is missing </style>");
  }

  const bodyEnd = prioritizedHtml.lastIndexOf("</body>");
  if (bodyEnd === -1) {
    throw new Error("Application HTML is missing </body>");
  }
  const bootstrapScript = afterFirstPaintScript({
    applicationModule: srcFromScript(applicationModule),
    modulePreloads: [hrefFromLink(runtimePreload), hrefFromLink(vendorPreload)],
    stylesheet: hrefFromLink(stylesheet),
  });
  const bodyClosingLineStart = prioritizedHtml.lastIndexOf("\n", bodyEnd) + 1;
  if (prioritizedHtml.slice(bodyClosingLineStart, bodyEnd).trim()) {
    return `${prioritizedHtml.slice(0, bodyEnd)}${bootstrapScript}${prioritizedHtml.slice(bodyEnd)}`;
  }
  return `${prioritizedHtml.slice(0, bodyClosingLineStart)}${bootstrapScript}\n${prioritizedHtml.slice(bodyClosingLineStart)}`;
}

export function applicationAfterFirstPaintHtmlPlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-application-after-first-paint-html",
    transformIndexHtml: {
      order: "post",
      handler(htmlSource) {
        return deferApplicationResourcesUntilFirstPaint(htmlSource);
      },
    },
  };
}
