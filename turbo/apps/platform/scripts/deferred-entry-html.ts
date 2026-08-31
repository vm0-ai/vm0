import { createHash } from "node:crypto";

import {
  defaultTreeAdapter,
  html as htmlConstants,
  parse,
  serializeOuter,
  type DefaultTreeAdapterTypes,
} from "parse5";
import { transformWithEsbuild, type Plugin, type ResolvedConfig } from "vite";

const APP_ENTRY_ATTRIBUTE = "data-vm0-app-entry";
const APP_MODULE_PRELOAD_ATTRIBUTE = "data-vm0-app-module-preload";
const APP_STYLESHEET_ATTRIBUTE = "data-vm0-app-stylesheet";
const AFTER_FIRST_PAINT_ENTRY_ATTRIBUTE = "data-vm0-after-first-paint-entry";
const AFTER_FIRST_PAINT_ENTRY_PLACEHOLDER =
  "__VM0_AFTER_FIRST_PAINT_ENTRY_URL__";

type ExtractedAfterFirstPaintBootstrap = {
  readonly html: string;
  readonly source: string;
};

type InlineBlockKind = "script" | "style";

type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlNode = DefaultTreeAdapterTypes.Node;

type HtmlReplacement = {
  readonly endOffset: number;
  readonly replacement: string;
  readonly startOffset: number;
};

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function htmlElements(html: string): readonly HtmlElement[] {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const elements: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (isElement(node) && node.sourceCodeLocation !== undefined) {
      elements.push(node);
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        visit(child);
      }
    }
  };
  visit(document);
  return elements;
}

function attributeValue(
  element: HtmlElement,
  name: string,
): string | undefined {
  return element.attrs.find((attribute) => {
    return attribute.name === name;
  })?.value;
}

function hasAttribute(element: HtmlElement, name: string): boolean {
  return element.attrs.some((attribute) => {
    return attribute.name === name;
  });
}

function applyHtmlReplacements(
  html: string,
  replacements: readonly HtmlReplacement[],
): string {
  const sorted = [...replacements].sort((left, right) => {
    return right.startOffset - left.startOffset;
  });
  let earliestOffset = html.length;
  let output = html;
  for (const replacement of sorted) {
    if (
      replacement.startOffset < 0 ||
      replacement.endOffset < replacement.startOffset ||
      replacement.endOffset > earliestOffset
    ) {
      throw new Error("Invalid or overlapping HTML replacement");
    }
    output =
      output.slice(0, replacement.startOffset) +
      replacement.replacement +
      output.slice(replacement.endOffset);
    earliestOffset = replacement.startOffset;
  }
  return output;
}

function inertResourceTag(
  sourceElement: HtmlElement,
  href: string,
  marker: string,
): string {
  const attributes = [];
  if (hasAttribute(sourceElement, "crossorigin")) {
    attributes.push({
      name: "crossorigin",
      value: attributeValue(sourceElement, "crossorigin") ?? "",
    });
  }
  attributes.push({ name: "href", value: href }, { name: marker, value: "" });
  const link = defaultTreeAdapter.createElement(
    "link",
    htmlConstants.NS.HTML,
    attributes,
  );
  return serializeOuter(link);
}

function deferredApplicationScriptReplacement(
  html: string,
  element: HtmlElement,
): HtmlReplacement | undefined {
  const location = element.sourceCodeLocation;
  if (
    element.tagName !== "script" ||
    location?.startTag === undefined ||
    location.endTag === undefined ||
    html
      .slice(location.startTag.endOffset, location.endTag.startOffset)
      .trim() !== ""
  ) {
    return undefined;
  }
  const href = attributeValue(element, "src");
  const isSourceEntry = hasAttribute(element, APP_ENTRY_ATTRIBUTE);
  const isBuiltEntry =
    attributeValue(element, "type") === "module" && href?.endsWith(".js");
  if (!isSourceEntry && !isBuiltEntry) {
    return undefined;
  }
  if (href === undefined) {
    throw new Error("Deferred app entry is missing its source URL");
  }
  return {
    endOffset: location.endOffset,
    replacement: inertResourceTag(element, href, APP_ENTRY_ATTRIBUTE),
    startOffset: location.startOffset,
  };
}

function deferredApplicationLinkReplacement(
  element: HtmlElement,
): HtmlReplacement | undefined {
  const location = element.sourceCodeLocation;
  if (element.tagName !== "link" || location?.startTag === undefined) {
    return undefined;
  }
  const href = attributeValue(element, "href");
  let marker: string | undefined;
  if (
    attributeValue(element, "rel") === "modulepreload" &&
    href?.endsWith(".js") &&
    hasAttribute(element, "crossorigin")
  ) {
    marker = APP_MODULE_PRELOAD_ATTRIBUTE;
  } else if (
    attributeValue(element, "rel") === "stylesheet" &&
    href?.endsWith(".css") &&
    hasAttribute(element, "crossorigin")
  ) {
    marker = APP_STYLESHEET_ATTRIBUTE;
  }
  if (href === undefined || marker === undefined) {
    return undefined;
  }
  return {
    endOffset: location.startTag.endOffset,
    replacement: inertResourceTag(element, href, marker),
    startOffset: location.startTag.startOffset,
  };
}

export function deferApplicationEntryResources(html: string): string {
  let applicationEntries = 0;
  const replacements: HtmlReplacement[] = [];
  for (const element of htmlElements(html)) {
    const scriptReplacement = deferredApplicationScriptReplacement(
      html,
      element,
    );
    if (scriptReplacement !== undefined) {
      applicationEntries += 1;
      replacements.push(scriptReplacement);
      continue;
    }
    const linkReplacement = deferredApplicationLinkReplacement(element);
    if (linkReplacement !== undefined) {
      replacements.push(linkReplacement);
    }
  }
  if (applicationEntries !== 1) {
    throw new Error(
      `Expected exactly one deferred app entry, found ${applicationEntries}`,
    );
  }

  return applyHtmlReplacements(html, replacements);
}

export function extractAfterFirstPaintBootstrap(
  html: string,
): ExtractedAfterFirstPaintBootstrap {
  const callbacks: string[] = [];
  let insertedEntrypoint = false;
  const replacements: HtmlReplacement[] = [];
  for (const element of htmlElements(html)) {
    const location = element.sourceCodeLocation;
    if (
      element.tagName !== "script" ||
      element.attrs.length !== 0 ||
      location?.startTag === undefined ||
      location.endTag === undefined
    ) {
      continue;
    }
    const source = html.slice(
      location.startTag.endOffset,
      location.endTag.startOffset,
    );
    if (
      !source
        .trimStart()
        .startsWith("window.__vm0AfterFirstPaint(function () {")
    ) {
      continue;
    }
    callbacks.push(source.trim());
    let replacement = "";
    if (insertedEntrypoint) {
      replacements.push({
        endOffset: location.endOffset,
        replacement,
        startOffset: location.startOffset,
      });
      continue;
    }
    insertedEntrypoint = true;
    replacement = `<link crossorigin href="${AFTER_FIRST_PAINT_ENTRY_PLACEHOLDER}" ${AFTER_FIRST_PAINT_ENTRY_ATTRIBUTE}="">
    <script data-vm0-after-first-paint-loader="">
      window.__vm0AfterFirstPaint(function () {
        if (window.__vm0BrowserSupported === true) {
          var modulePreloads = document.querySelectorAll(
            'link[${APP_ENTRY_ATTRIBUTE}=""], link[${APP_MODULE_PRELOAD_ATTRIBUTE}=""]',
          );
          for (var index = 0; index < modulePreloads.length; index += 1) {
            modulePreloads[index].rel = "modulepreload";
          }

          var appStylesheet = document.querySelector(
            'link[${APP_STYLESHEET_ATTRIBUTE}=""]',
          );
          if (appStylesheet) {
            appStylesheet.rel = "preload";
            appStylesheet.as = "style";
          }

          var fontStylesheet = document.querySelector(
            'link[data-vm0-font-stylesheet=""]',
          );
          if (fontStylesheet) {
            fontStylesheet.rel = "preload";
            fontStylesheet.as = "style";
          }
        }

        var entry = document.querySelector(
          'link[${AFTER_FIRST_PAINT_ENTRY_ATTRIBUTE}=""]',
        );
        if (!entry) return;

        var script = document.createElement("script");
        script.src = entry.href;
        script.crossOrigin = "anonymous";
        document.head.appendChild(script);
      });
    </script>`;
    replacements.push({
      endOffset: location.endOffset,
      replacement,
      startOffset: location.startOffset,
    });
  }
  if (callbacks.length === 0) {
    throw new Error("Expected deferred after-first-paint bootstrap callbacks");
  }

  return {
    html: applyHtmlReplacements(html, replacements),
    source: `"use strict";\n${callbacks.join("\n")}\n`,
  };
}

async function minifyInlineBlock(
  kind: InlineBlockKind,
  element: HtmlElement,
  source: string,
): Promise<string> {
  if (source.trim() === "") {
    return source;
  }
  if (kind === "script") {
    if (hasAttribute(element, "src")) {
      return source;
    }
    const type = attributeValue(element, "type");
    if (type !== undefined && type !== "module" && type !== "text/javascript") {
      return source;
    }
  }
  const transformed = await transformWithEsbuild(
    source,
    kind === "script" ? "inline-bootstrap.js" : "inline-bootstrap.css",
    {
      legalComments: "none",
      loader: kind === "script" ? "js" : "css",
      minify: true,
      target: "es2020",
    },
  );
  return transformed.code.trim();
}

async function minifyInlineBootstrap(html: string): Promise<string> {
  const replacements: HtmlReplacement[] = [];
  for (const element of htmlElements(html)) {
    if (element.tagName !== "script" && element.tagName !== "style") {
      continue;
    }
    const location = element.sourceCodeLocation;
    if (location?.startTag === undefined || location.endTag === undefined) {
      continue;
    }
    const source = html.slice(
      location.startTag.endOffset,
      location.endTag.startOffset,
    );
    const minified = await minifyInlineBlock(element.tagName, element, source);
    replacements.push({
      endOffset: location.endTag.startOffset,
      replacement: minified,
      startOffset: location.startTag.endOffset,
    });
  }
  const minified = applyHtmlReplacements(html, replacements);
  const whitespaceReplacements: HtmlReplacement[] = [];
  const document = parse(minified, { sourceCodeLocationInfo: true });
  const visit = (node: HtmlNode): void => {
    if (
      node.nodeName === "#text" &&
      node.value.trim() === "" &&
      node.sourceCodeLocation !== undefined &&
      node.sourceCodeLocation !== null
    ) {
      whitespaceReplacements.push({
        endOffset: node.sourceCodeLocation.endOffset,
        replacement: "",
        startOffset: node.sourceCodeLocation.startOffset,
      });
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        visit(child);
      }
    }
  };
  visit(document);
  return applyHtmlReplacements(minified, whitespaceReplacements).trim();
}

function assetUrl(config: ResolvedConfig, fileName: string): string {
  return `${config.base.replace(/\/?$/u, "/")}${fileName}`;
}

export function deferredApplicationEntryHtmlPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig | undefined;
  return {
    name: "platform-deferred-application-entry-html",
    configResolved(config) {
      resolvedConfig = config;
    },
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        const deferredHtml = deferApplicationEntryResources(html);
        if (resolvedConfig?.command !== "build") {
          return deferredHtml;
        }
        const extracted = extractAfterFirstPaintBootstrap(deferredHtml);
        const minifiedSource = (
          await transformWithEsbuild(
            extracted.source,
            "bootstrap-after-first-paint.js",
            {
              legalComments: "none",
              loader: "js",
              minify: true,
              target: "es2020",
            },
          )
        ).code.trim();
        const digest = createHash("sha256")
          .update(minifiedSource)
          .digest("hex")
          .slice(0, 12);
        const fileName = `assets/bootstrap-after-first-paint-${digest}.js`;
        this.emitFile({
          type: "asset",
          fileName,
          source: minifiedSource,
        });
        const entryUrl = assetUrl(resolvedConfig, fileName);
        return await minifyInlineBootstrap(
          extracted.html.replace(AFTER_FIRST_PAINT_ENTRY_PLACEHOLDER, entryUrl),
        );
      },
    },
  };
}
