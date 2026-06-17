const SLIDE_SELECTORS = [
  "[data-vm0-slide]",
  "[data-slide-id]",
  "[data-slide]",
  "[data-slide-index]",
  "[data-page]",
  ".ppt-slide",
  ".presentation-slide",
  ".deck-slide",
  ".slide-page",
  ".slide",
  "section",
] as const;

const UNSAFE_PREVIEW_URL_PROTOCOLS = [
  "data:",
  "javascript:",
  "vbscript:",
] as const;

export interface PresentationPreviewSlide {
  readonly id: string;
  readonly title: string;
}

export interface PresentationPreviewDeck {
  readonly html: string;
  readonly slides: readonly PresentationPreviewSlide[];
}

function isHTMLElement(value: Element): value is HTMLElement {
  return value instanceof HTMLElement;
}

function slideIdForElement(slide: Element, index: number): string {
  if (!isHTMLElement(slide)) {
    return `slide-${index + 1}`;
  }
  return (
    slide.dataset.slideId ?? slide.getAttribute("id") ?? `slide-${index + 1}`
  );
}

function slideTitle(slide: Element, fallback: string): string {
  const titleElement = slide.querySelector(
    "h1,h2,h3,h4,h5,h6,[data-vm0-editable='text']",
  );
  const text = titleElement?.textContent?.trim() ?? "";
  return text ? text.slice(0, 80) : fallback;
}

function selectSlideElements(doc: Document): Element[] {
  for (const selector of SLIDE_SELECTORS) {
    const slides = Array.from(doc.querySelectorAll(selector));
    if (slides.length > 0) {
      return slides;
    }
  }
  return doc.body ? [doc.body] : [];
}

function hasUnsafePreviewUrlProtocol(value: string): boolean {
  let compact = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && code > 0x20 && code !== 0x7f) {
      compact += char;
    }
  }
  compact = compact.toLowerCase();
  if (
    UNSAFE_PREVIEW_URL_PROTOCOLS.some((protocol) => {
      return compact.startsWith(protocol);
    })
  ) {
    return true;
  }
  if (!URL.canParse(value, "https://vm0.invalid/")) {
    return false;
  }
  const protocol = new URL(
    value,
    "https://vm0.invalid/",
  ).protocol.toLowerCase();
  return UNSAFE_PREVIEW_URL_PROTOCOLS.includes(
    protocol as (typeof UNSAFE_PREVIEW_URL_PROTOCOLS)[number],
  );
}

function sanitizePreviewTree(root: ParentNode): void {
  for (const element of Array.from(
    root.querySelectorAll("script,noscript,iframe,object,embed"),
  )) {
    element.remove();
  }
  for (const meta of Array.from(root.querySelectorAll("meta[http-equiv]"))) {
    const httpEquiv = meta.getAttribute("http-equiv")?.toLowerCase();
    if (httpEquiv === "refresh" || httpEquiv === "content-security-policy") {
      meta.remove();
    }
  }
  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        ((name === "href" ||
          name === "src" ||
          name === "srcdoc" ||
          name === "xlink:href") &&
          hasUnsafePreviewUrlProtocol(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function serializeDoc(doc: Document): string {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function htmlAttributeValue(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function serializePreviewDoc(doc: Document, sourceUrl: string): string {
  const html = serializeDoc(doc);
  return html.replace(
    "<head>",
    `<head><base href="${htmlAttributeValue(sourceUrl)}">`,
  );
}

export function parsePresentationPreviewDeck(
  html: string,
): PresentationPreviewDeck {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const slides = selectSlideElements(doc).map(
    (slide, index): PresentationPreviewSlide => {
      return {
        id: slideIdForElement(slide, index),
        title: slideTitle(slide, `Slide ${index + 1}`),
      };
    },
  );
  return { html, slides };
}

export function previewPresentationSlideHtml(params: {
  readonly activeSlideId: string;
  readonly html: string;
  readonly sourceUrl: string;
}): string {
  const doc = new DOMParser().parseFromString(params.html, "text/html");
  sanitizePreviewTree(doc);
  const previewDoc = document.implementation.createHTMLDocument(
    doc.title || "Presentation preview",
  );
  for (const node of Array.from(doc.head.childNodes)) {
    previewDoc.head.append(node.cloneNode(true));
  }
  const stage = previewDoc.createElement("div");
  stage.dataset.vm0PresentationPreviewStage = "true";
  previewDoc.body.append(stage);
  for (const [index, slide] of selectSlideElements(doc).entries()) {
    if (slideIdForElement(slide, index) !== params.activeSlideId) {
      continue;
    }
    const slideClone = slide.cloneNode(true);
    if (slideClone instanceof Element) {
      sanitizePreviewTree(slideClone);
    }
    stage.append(slideClone);
    break;
  }
  const style = previewDoc.createElement("style");
  style.textContent = `
    html, body {
      width: 100%;
      height: 100%;
      margin: 0 !important;
      overflow: hidden !important;
      background: #fff !important;
    }
    body {
      display: block !important;
    }
    [data-vm0-presentation-preview-stage] {
      width: 100%;
      height: 100%;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      overflow: hidden !important;
    }
    [data-vm0-presentation-preview-stage] > * {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      max-width: 100% !important;
      max-height: 100% !important;
      margin: 0 !important;
      box-sizing: border-box !important;
    }
  `;
  previewDoc.head.append(style);
  const csp = previewDoc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content =
    "default-src * data: blob: 'unsafe-inline'; script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'";
  previewDoc.head.prepend(csp);
  return serializePreviewDoc(previewDoc, params.sourceUrl);
}

export function pointerIndexForClientX(params: {
  readonly clientX: number;
  readonly count: number;
  readonly rect: Pick<DOMRect, "left" | "width">;
}): number {
  if (params.count <= 1 || params.rect.width <= 0) {
    return 0;
  }
  const ratio = (params.clientX - params.rect.left) / params.rect.width;
  const clampedRatio = Math.min(0.999999, Math.max(0, ratio));
  return Math.floor(clampedRatio * params.count);
}
