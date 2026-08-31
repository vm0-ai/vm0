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
        return await minifyInlineBootstrap(deferredHtml);
      },
    },
  };
}
