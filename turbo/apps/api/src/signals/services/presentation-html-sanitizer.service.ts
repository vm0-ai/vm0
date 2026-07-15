import {
  defaultTreeAdapter,
  html as parse5Html,
  parse,
  serialize,
  type DefaultTreeAdapterTypes,
} from "parse5";

import { safeJsonParse } from "../utils";

const DECK_METADATA_SCRIPT_ID = "vm0-deck-metadata";
const PRESENTATION_CSP = [
  "default-src 'none'",
  "base-uri https:",
  "connect-src 'none'",
  "font-src 'self' https: data:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'self' https: data:",
  "media-src 'self' https: data:",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline' https: data:",
  "worker-src 'none'",
].join("; ");

const BLOCKED_ELEMENTS = [
  "applet",
  "base",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "noscript",
  "object",
] as const;
const ACTIVE_URL_ATTRIBUTES = [
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "xlink:href",
] as const;
const BLOCKED_META_HTTP_EQUIV = ["content-security-policy", "refresh"] as const;
const UNSAFE_PROTOCOLS = ["javascript:", "vbscript:"] as const;
const SAFE_DATA_IMAGE_PATTERN =
  /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i;

const SLIDE_MATCHERS = [
  { attribute: "data-vm0-slide" },
  { attribute: "data-slide" },
  { attribute: "data-slide-index" },
  { attribute: "data-page" },
  { className: "ppt-slide" },
  { className: "presentation-slide" },
  { className: "deck-slide" },
  { className: "slide-page" },
  { className: "slide" },
  { tagName: "section" },
] as const;

type HtmlDocument = DefaultTreeAdapterTypes.Document;
type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlParentNode = DefaultTreeAdapterTypes.ParentNode;

interface SlideMatcher {
  readonly attribute?: string;
  readonly className?: string;
  readonly tagName?: string;
}

interface SanitizedPresentationHtml {
  readonly html: string;
  readonly slideCount: number;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function attributeValue(element: HtmlElement, name: string): string | null {
  return (
    element.attrs.find((attribute) => {
      return attribute.name.toLowerCase() === name;
    })?.value ?? null
  );
}

function textContent(node: HtmlParentNode): string {
  return node.childNodes
    .map((child) => {
      if (child.nodeName === "#text" && "value" in child) {
        return child.value;
      }
      return "childNodes" in child ? textContent(child) : "";
    })
    .join("");
}

function isDeckMetadataScript(element: HtmlElement): boolean {
  if (element.tagName !== "script") {
    return false;
  }
  if (
    attributeValue(element, "id") !== DECK_METADATA_SCRIPT_ID ||
    attributeValue(element, "type")?.toLowerCase() !== "application/json" ||
    attributeValue(element, "src") !== null
  ) {
    return false;
  }
  return safeJsonParse(textContent(element)) !== undefined;
}

function shouldRemoveElement(element: HtmlElement): boolean {
  if (element.tagName === "script") {
    return !isDeckMetadataScript(element);
  }
  if (includesString(BLOCKED_ELEMENTS, element.tagName)) {
    return true;
  }
  if (element.tagName !== "meta") {
    return false;
  }
  const httpEquiv = attributeValue(element, "http-equiv")?.toLowerCase();
  return httpEquiv ? includesString(BLOCKED_META_HTTP_EQUIV, httpEquiv) : false;
}

function isUnsafeUrl(
  element: HtmlElement,
  attributeName: string,
  value: string,
  sourceUrl: string,
): boolean {
  if (!URL.canParse(value, sourceUrl)) {
    return true;
  }
  const url = new URL(value, sourceUrl);
  if (url.protocol.toLowerCase() === "data:") {
    return !(
      element.tagName === "img" &&
      attributeName === "src" &&
      SAFE_DATA_IMAGE_PATTERN.test(value)
    );
  }
  return includesString(UNSAFE_PROTOCOLS, url.protocol.toLowerCase());
}

function isUnsafeSrcset(
  element: HtmlElement,
  value: string,
  sourceUrl: string,
): boolean {
  return value.split(",").some((candidate) => {
    const [url] = candidate.trim().split(/\s+/, 1);
    return !url || isUnsafeUrl(element, "srcset", url, sourceUrl);
  });
}

function sanitizeAttributes(element: HtmlElement, sourceUrl: string): void {
  if (isDeckMetadataScript(element)) {
    element.attrs = [
      { name: "id", value: DECK_METADATA_SCRIPT_ID },
      { name: "type", value: "application/json" },
    ];
    return;
  }

  element.attrs = element.attrs.filter((attribute) => {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || name === "ping" || name === "srcdoc") {
      return false;
    }
    if (name === "srcset") {
      return !isUnsafeSrcset(element, attribute.value, sourceUrl);
    }
    if (includesString(ACTIVE_URL_ATTRIBUTES, name)) {
      return !isUnsafeUrl(element, name, attribute.value, sourceUrl);
    }
    return true;
  });
}

function sanitizeChildren(parent: HtmlParentNode, sourceUrl: string): void {
  const children = parent.childNodes.filter((child) => {
    return !isElement(child) || !shouldRemoveElement(child);
  });
  parent.childNodes = children;

  for (const child of children) {
    child.parentNode = parent;
    if (!isElement(child)) {
      continue;
    }
    sanitizeAttributes(child, sourceUrl);
    sanitizeChildren(child, sourceUrl);
    if (child.tagName === "template" && "content" in child) {
      sanitizeChildren(child.content, sourceUrl);
    }
  }
}

function findElement(
  node: HtmlParentNode,
  tagName: string,
): HtmlElement | null {
  for (const child of node.childNodes) {
    if (isElement(child)) {
      if (child.tagName === tagName) {
        return child;
      }
      const nested = findElement(child, tagName);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function prependSecurityElements(
  document: HtmlDocument,
  sourceUrl: string,
): void {
  const head = findElement(document, "head");
  if (!head) {
    throw new Error("Rendered presentation HTML has no head element");
  }
  const csp = defaultTreeAdapter.createElement("meta", parse5Html.NS.HTML, [
    { name: "http-equiv", value: "Content-Security-Policy" },
    { name: "content", value: PRESENTATION_CSP },
  ]);
  const base = defaultTreeAdapter.createElement("base", parse5Html.NS.HTML, [
    { name: "href", value: sourceUrl },
  ]);
  csp.parentNode = head;
  base.parentNode = head;
  head.childNodes.unshift(csp, base);
}

function matchesSlide(element: HtmlElement, matcher: SlideMatcher): boolean {
  if (matcher.tagName && element.tagName === matcher.tagName) {
    return true;
  }
  if (
    matcher.attribute &&
    element.attrs.some((attribute) => {
      return attribute.name.toLowerCase() === matcher.attribute;
    })
  ) {
    return true;
  }
  const className = attributeValue(element, "class");
  return Boolean(
    matcher.className && className?.split(/\s+/).includes(matcher.className),
  );
}

function countMatchingElements(
  node: HtmlParentNode,
  matcher: SlideMatcher,
): number {
  return node.childNodes.reduce((count, child) => {
    if (!isElement(child)) {
      return count;
    }
    return (
      count +
      (matchesSlide(child, matcher) ? 1 : 0) +
      countMatchingElements(child, matcher)
    );
  }, 0);
}

function countSlides(document: HtmlDocument): number {
  for (const matcher of SLIDE_MATCHERS) {
    const count = countMatchingElements(document, matcher);
    if (count > 0) {
      return count;
    }
  }
  return 0;
}

export function sanitizeMaterializedPresentationHtml(
  sourceHtml: string,
  sourceUrl: string,
): SanitizedPresentationHtml {
  const document = parse(sourceHtml);
  sanitizeChildren(document, sourceUrl);
  prependSecurityElements(document, sourceUrl);
  return {
    html: serialize(document),
    slideCount: countSlides(document),
  };
}
