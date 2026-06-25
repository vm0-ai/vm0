import {
  HTML_DOM_EDIT_PAYLOAD_TYPE,
  type HtmlDomEditComment,
  type HtmlDomEditPayload,
} from "./html-dom-edit-types.ts";

export { HTML_DOM_EDIT_PAYLOAD_TYPE } from "./html-dom-edit-types.ts";

export const HTML_DOM_NODE_ID_ATTR = "data-vm0-node-id";
export const HTML_DOM_EDIT_OVERLAY_ATTR = "data-vm0-html-edit-overlay";
export const HTML_DOM_EDIT_TEMP_BASE_ATTR = "data-vm0-html-edit-base";

const DEFAULT_NODE_ID_PREFIX = "vm0-node";
const IGNORED_TAG_NAMES = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "head",
  "html",
  "iframe",
  "link",
  "meta",
  "noscript",
  "object",
  "param",
  "script",
  "source",
  "style",
  "template",
  "title",
  "track",
] as const;
const MEDIA_OR_CONTROL_SELECTOR = [
  "a[href]",
  "audio",
  "button",
  "canvas",
  "details",
  "dialog",
  "form",
  "img",
  "input",
  "label",
  "select",
  "summary",
  "svg",
  "textarea",
  "video",
].join(",");
const STRUCTURAL_SELECTOR = [
  "article",
  "aside",
  "blockquote",
  "div",
  "figure",
  "footer",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
].join(",");

export interface InstrumentHtmlDomEditWorkingCopyParams {
  readonly baseHref?: string;
  readonly html: string;
  readonly nodeIdPrefix?: string;
}

export interface InstrumentedHtmlDomEditWorkingCopy {
  readonly html: string;
  readonly nodeIds: readonly string[];
}

export function createHtmlDomEditPayload(params: {
  readonly comments: readonly HtmlDomEditComment[];
  readonly originalUrl: string;
  readonly workingCopyUrl: string;
}): HtmlDomEditPayload {
  return {
    type: HTML_DOM_EDIT_PAYLOAD_TYPE,
    originalUrl: params.originalUrl,
    workingCopyUrl: params.workingCopyUrl,
    comments: params.comments,
  };
}

export function instrumentHtmlDomEditWorkingCopy(
  params: InstrumentHtmlDomEditWorkingCopyParams,
): InstrumentedHtmlDomEditWorkingCopy {
  const doc = parseHtml(params.html);
  stripDomEditAttributes(doc);
  removeEditOverlayElements(doc);
  removeTemporaryBaseElements(doc);
  injectTemporaryBase(doc, params.baseHref);

  const nodeIds: string[] = [];
  let nextId = 1;
  const prefix = params.nodeIdPrefix?.trim() || DEFAULT_NODE_ID_PREFIX;

  for (const element of Array.from(
    doc.body.querySelectorAll<HTMLElement>("*"),
  )) {
    if (!isSelectableElement(element)) {
      continue;
    }

    const nodeId = `${prefix}-${nextId}`;
    nextId += 1;
    element.setAttribute(HTML_DOM_NODE_ID_ATTR, nodeId);
    nodeIds.push(nodeId);
  }

  return {
    html: serializeHtmlDocument(doc),
    nodeIds,
  };
}

export function stripHtmlDomEditInstrumentation(html: string): string {
  const doc = parseHtml(html);
  stripDomEditAttributes(doc);
  removeEditOverlayElements(doc);
  removeTemporaryBaseElements(doc);
  return serializeHtmlDocument(doc);
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function serializeHtmlDocument(doc: Document): string {
  const doctype = doc.doctype ? `<!doctype ${doc.doctype.name}>\n` : "";
  return `${doctype}${doc.documentElement.outerHTML}`;
}

function stripDomEditAttributes(doc: Document): void {
  for (const element of Array.from(
    doc.querySelectorAll<HTMLElement>(`[${HTML_DOM_NODE_ID_ATTR}]`),
  )) {
    element.removeAttribute(HTML_DOM_NODE_ID_ATTR);
  }
}

function removeEditOverlayElements(doc: Document): void {
  for (const element of Array.from(
    doc.querySelectorAll<HTMLElement>(`[${HTML_DOM_EDIT_OVERLAY_ATTR}]`),
  )) {
    element.remove();
  }
}

function removeTemporaryBaseElements(doc: Document): void {
  for (const element of Array.from(
    doc.querySelectorAll<HTMLBaseElement>(
      `base[${HTML_DOM_EDIT_TEMP_BASE_ATTR}]`,
    ),
  )) {
    element.remove();
  }
}

function injectTemporaryBase(
  doc: Document,
  baseHref: string | undefined,
): void {
  if (!baseHref || doc.head.querySelector("base")) {
    return;
  }

  const base = doc.createElement("base");
  base.href = baseHref;
  base.setAttribute(HTML_DOM_EDIT_TEMP_BASE_ATTR, "");
  doc.head.prepend(base);
}

function isSelectableElement(element: HTMLElement): boolean {
  if (isIgnoredElement(element) || isHiddenFromEditing(element)) {
    return false;
  }

  if (element.matches(MEDIA_OR_CONTROL_SELECTOR)) {
    return true;
  }

  if (hasUsefulText(element)) {
    return true;
  }

  return (
    element.matches(STRUCTURAL_SELECTOR) && hasSelectableDescendant(element)
  );
}

function isIgnoredElement(element: HTMLElement): boolean {
  return (
    IGNORED_TAG_NAMES.includes(
      element.tagName.toLowerCase() as (typeof IGNORED_TAG_NAMES)[number],
    ) || element.hasAttribute(HTML_DOM_EDIT_OVERLAY_ATTR)
  );
}

function isHiddenFromEditing(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") {
    return true;
  }

  const style = element.getAttribute("style")?.toLowerCase() ?? "";
  if (/\bdisplay\s*:\s*none\b/.test(style)) {
    return true;
  }
  if (/\bvisibility\s*:\s*hidden\b/.test(style)) {
    return true;
  }

  const parent = element.parentElement;
  return parent ? isHiddenFromEditing(parent) : false;
}

function hasUsefulText(element: HTMLElement): boolean {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().length > 0;
}

function hasSelectableDescendant(element: HTMLElement): boolean {
  return Array.from(element.children).some((child) => {
    return (
      child instanceof HTMLElement &&
      !isIgnoredElement(child) &&
      !isHiddenFromEditing(child)
    );
  });
}
