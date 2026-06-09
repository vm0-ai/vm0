const EDITABLE_SELECTOR = '[data-vm0-editable="text"]';
const METADATA_SCRIPT_ID = "vm0-deck-metadata";
const SLIDE_SELECTORS = [
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
const FALLBACK_EDITABLE_SELECTOR =
  "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th,span,div";
const UNSAFE_PREVIEW_URL_PROTOCOLS = [
  "data:",
  "javascript:",
  "vbscript:",
] as const;

export interface PresentationEditBlock {
  readonly editId: string;
  readonly slideId: string;
  readonly tagName: string;
  readonly text: string;
}

export interface PresentationSlideDraft {
  readonly id: string;
  readonly notes: string;
  readonly title: string;
}

export interface PresentationEditDraft {
  readonly blocks: readonly PresentationEditBlock[];
  readonly html: string;
  readonly slides: readonly PresentationSlideDraft[];
}

interface DeckMetadataSlide {
  readonly speakerNotes?: string;
}

interface DeckMetadata {
  readonly editProtocolVersion?: number;
  readonly kind?: string;
  readonly slides?: Record<string, DeckMetadataSlide>;
}

interface MutableDeckMetadata {
  editProtocolVersion?: number;
  kind?: string;
  slides?: Record<string, { speakerNotes?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDeckMetadata(doc: Document): DeckMetadata {
  const script = doc.getElementById(METADATA_SCRIPT_ID);
  if (!script?.textContent) {
    return {};
  }
  const parsed: unknown = JSON.parse(script.textContent);
  if (!isRecord(parsed)) {
    return {};
  }
  const slidesValue = parsed.slides;
  const slides: Record<string, DeckMetadataSlide> = {};
  if (isRecord(slidesValue)) {
    for (const [slideId, value] of Object.entries(slidesValue)) {
      if (!isRecord(value)) {
        continue;
      }
      const notes = value.speakerNotes;
      slides[slideId] =
        typeof notes === "string" ? { speakerNotes: notes } : {};
    }
  }
  return {
    editProtocolVersion:
      typeof parsed.editProtocolVersion === "number"
        ? parsed.editProtocolVersion
        : undefined,
    kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
    slides,
  };
}

function serializeDoc(doc: Document): string {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function slideIdForElement(slide: Element, index: number): string {
  return slide instanceof HTMLElement
    ? (slide.dataset.slideId ?? `slide-${index + 1}`)
    : `slide-${index + 1}`;
}

function editIdForElement(editable: Element, index: number): string | null {
  if (!(editable instanceof HTMLElement)) {
    return `text-${index + 1}`;
  }
  return (
    editable.dataset.vm0EditId ??
    editable.dataset.editId ??
    editable.dataset.vm0NodeId ??
    editable.dataset.nodeId ??
    `text-${index + 1}`
  );
}

function ensureEditIdForElement(editable: Element, index: number): string {
  const editId = editIdForElement(editable, index) ?? `text-${index + 1}`;
  if (editable instanceof HTMLElement && !editable.dataset.vm0EditId) {
    editable.dataset.vm0EditId = editId;
  }
  return editId;
}

function slideTitle(slide: Element, fallback: string): string {
  const firstEditable =
    slide.querySelector(EDITABLE_SELECTOR) ??
    selectEditableElements(slide)[0] ??
    null;
  const text = firstEditable?.textContent?.trim();
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

function hasUsefulText(element: Element): boolean {
  return Boolean(element.textContent?.trim());
}

function isLeafTextElement(element: Element): boolean {
  return !Array.from(element.children).some((child) => {
    return child.matches(FALLBACK_EDITABLE_SELECTOR) && hasUsefulText(child);
  });
}

function selectEditableElements(slide: Element): Element[] {
  const protocolEditables = Array.from(
    slide.querySelectorAll(EDITABLE_SELECTOR),
  );
  if (protocolEditables.length > 0) {
    return protocolEditables;
  }
  return Array.from(slide.querySelectorAll(FALLBACK_EDITABLE_SELECTOR)).filter(
    (element) => {
      return hasUsefulText(element) && isLeafTextElement(element);
    },
  );
}

export function parsePresentationEditDraft(
  html: string,
): PresentationEditDraft {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const metadata = parseDeckMetadata(doc);
  const slideElements = selectSlideElements(doc);
  const slides = slideElements.map((slide, index): PresentationSlideDraft => {
    const id = slideIdForElement(slide, index);
    return {
      id,
      notes: metadata.slides?.[id]?.speakerNotes ?? "",
      title: slideTitle(slide, `Slide ${index + 1}`),
    };
  });
  const blocks = slideElements.flatMap(
    (slide, slideIndex): PresentationEditBlock[] => {
      const slideId = slideIdForElement(slide, slideIndex);
      return selectEditableElements(slide).map(
        (editable, blockIndex): PresentationEditBlock => {
          const editId = ensureEditIdForElement(editable, blockIndex);
          return {
            editId,
            slideId,
            tagName: editable.tagName.toLowerCase(),
            text: editable.textContent ?? "",
          };
        },
      );
    },
  );
  return { blocks, html: serializeDoc(doc), slides };
}

function findSlide(doc: Document, slideId: string): Element | null {
  return (
    selectSlideElements(doc).find((slide, index) => {
      return slideIdForElement(slide, index) === slideId;
    }) ?? null
  );
}

function findEditable(slide: Element, editId: string): Element | null {
  return (
    selectEditableElements(slide).find((editable, index) => {
      return editIdForElement(editable, index) === editId;
    }) ?? null
  );
}

function ensureMetadataScript(doc: Document): HTMLScriptElement {
  const existing = doc.getElementById(METADATA_SCRIPT_ID);
  if (existing instanceof HTMLScriptElement) {
    existing.type = "application/json";
    return existing;
  }
  const script = doc.createElement("script");
  script.type = "application/json";
  script.id = METADATA_SCRIPT_ID;
  doc.body.append(script);
  return script;
}

function sanitizePreviewTree(root: ParentNode): void {
  for (const element of Array.from(
    root.querySelectorAll("script,noscript,iframe,object,embed"),
  )) {
    element.remove();
  }
  for (const meta of Array.from(root.querySelectorAll("meta[http-equiv]"))) {
    if (meta.getAttribute("http-equiv")?.toLowerCase() === "refresh") {
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

function hasUnsafePreviewUrlProtocol(value: string): boolean {
  // Strip ASCII control characters and whitespace to normalise obfuscated
  // schemes such as "j a v a s c r i p t:" or "java\x00script:".
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

function sanitizePreviewDocument(doc: Document): void {
  sanitizePreviewTree(doc);
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content =
    "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'";
  doc.head.prepend(csp);
}

export function patchPresentationHtml(params: {
  readonly blocks: readonly PresentationEditBlock[];
  readonly html: string;
  readonly slides: readonly PresentationSlideDraft[];
}): string {
  const doc = new DOMParser().parseFromString(params.html, "text/html");
  for (const block of params.blocks) {
    const slide = findSlide(doc, block.slideId);
    const editable = slide ? findEditable(slide, block.editId) : null;
    if (editable && editable.textContent !== block.text) {
      editable.textContent = block.text;
    }
  }

  const metadata = parseDeckMetadata(doc) as MutableDeckMetadata;
  metadata.kind = "presentation-html";
  metadata.editProtocolVersion = metadata.editProtocolVersion ?? 1;
  metadata.slides = metadata.slides ?? {};
  for (const slide of params.slides) {
    metadata.slides[slide.id] = {
      ...metadata.slides[slide.id],
      speakerNotes: slide.notes,
    };
  }
  ensureMetadataScript(doc).textContent = JSON.stringify(metadata, null, 2);
  return serializeDoc(doc);
}

export function previewPresentationHtml(params: {
  readonly activeSlideId: string;
  readonly html: string;
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
  stage.dataset.vm0EditorStage = "true";
  previewDoc.body.append(stage);
  for (const [index, slide] of selectSlideElements(doc).entries()) {
    if (slideIdForElement(slide, index) === params.activeSlideId) {
      const slideId = slideIdForElement(slide, index);
      for (const [editableIndex, editable] of selectEditableElements(
        slide,
      ).entries()) {
        if (editable instanceof HTMLElement) {
          editable.dataset.vm0EditorSlideId = slideId;
          editable.dataset.vm0EditorEditId =
            editIdForElement(editable, editableIndex) ?? "";
        }
      }
      const slideClone = slide.cloneNode(true);
      if (slideClone instanceof Element) {
        sanitizePreviewTree(slideClone);
      }
      stage.append(slideClone);
      break;
    }
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
    [data-vm0-editor-stage] {
      width: 100%;
      height: 100%;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      overflow: hidden !important;
    }
    [data-vm0-editor-stage] > * {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      max-width: 100% !important;
      max-height: 100% !important;
      margin: 0 !important;
      box-sizing: border-box !important;
    }
    [data-vm0-editor-edit-id] {
      cursor: text !important;
      outline: 2px solid transparent !important;
      outline-offset: 4px !important;
      z-index: 2 !important;
      pointer-events: auto !important;
      user-select: text !important;
      -webkit-user-select: text !important;
      -webkit-user-modify: read-write-plaintext-only !important;
      caret-color: auto !important;
    }
    [data-vm0-editor-edit-id]:hover,
    [data-vm0-editor-edit-id]:focus {
      outline-color: #0f82ff !important;
    }
  `;
  previewDoc.head.append(style);
  sanitizePreviewDocument(previewDoc);
  return serializeDoc(previewDoc);
}
