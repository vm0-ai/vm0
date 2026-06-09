import { publicAttachmentUrl } from "./zero-attachment-url.ts";
import domToPptxBundleUrl from "../../../node_modules/dom-to-pptx/dist/dom-to-pptx.bundle.js?url";
import JSZip from "jszip";
import {
  createDeferredPromise,
  jsonParseOr,
  settle,
  withCleanup,
} from "../../signals/utils.ts";

const EXPORT_FONT_READY_TIMEOUT_MS = 800;
const DEV_ARTIFACT_FETCH_PROXY_PATH = "/__vm0-dev-artifact-fetch";
const METADATA_SCRIPT_ID = "vm0-deck-metadata";
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const PRESENTATION_PATH = "ppt/presentation.xml";
const PRESENTATION_RELS_PATH = "ppt/_rels/presentation.xml.rels";
const CONTENT_TYPES_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELATIONSHIPS_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PRESENTATION_NS =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NOTES_MASTER_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster";
const NOTES_SLIDE_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const NOTES_MASTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml";
const NOTES_SLIDE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const NOTES_MASTER_REL_TARGET = "notesMasters/notesMaster1.xml";
const SLIDE_SELECTORS = [
  "[data-vm0-slide]",
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

type DomToPptxOptions = {
  readonly fileName: string;
  readonly layout: "LAYOUT_WIDE";
  readonly skipDownload: boolean;
  readonly svgAsVector: boolean;
};

type ExportFrameMessage =
  | {
      readonly blob?: unknown;
      readonly status: "success";
      readonly type: "vm0-presentation-pptx-export";
    }
  | {
      readonly message: string;
      readonly status: "error";
      readonly type: "vm0-presentation-pptx-export";
    };

interface PresentationPptxSpeakerNote {
  readonly notes: string;
  readonly slideNumber: number;
}

interface DeckMetadataSlide {
  readonly speakerNotes?: string;
}

interface DeckMetadata {
  readonly slides?: Record<string, DeckMetadataSlide>;
}

function pptxFilename(filename: string): string {
  const base = filename
    .replace(/[\\/]/g, "-")
    .replace(/\.(html?|xhtml)$/i, "")
    .trim();
  return `${base || "presentation"}.pptx`;
}

function domToPptxScriptUrl(): string {
  const origin = URL.canParse(window.location.origin)
    ? window.location.origin
    : "http://localhost";
  return new URL(domToPptxBundleUrl, origin).toString();
}

function canUseDevArtifactFetchProxy(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  return ["app.vm7.ai", "localhost", "127.0.0.1"].includes(
    window.location.hostname,
  );
}

function isDevArtifactFetchProxyTarget(url: URL): boolean {
  if (url.protocol !== "https:") {
    return false;
  }
  return (
    url.hostname === "cdn.vm0.io" ||
    url.hostname === "cdn.vm7.io" ||
    url.hostname.endsWith(".sites.vm0.io") ||
    url.hostname.endsWith(".sites.vm7.io")
  );
}

export function readablePresentationResourceUrl(url: string): string {
  if (!canUseDevArtifactFetchProxy() || !URL.canParse(url)) {
    return url;
  }
  const parsed = new URL(url);
  if (!isDevArtifactFetchProxyTarget(parsed)) {
    return url;
  }
  return `${DEV_ARTIFACT_FETCH_PROXY_PATH}?url=${encodeURIComponent(url)}`;
}

function isExportFrameMessage(value: unknown): value is ExportFrameMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    readonly message?: unknown;
    readonly status?: unknown;
    readonly type?: unknown;
  };
  return (
    candidate.type === "vm0-presentation-pptx-export" &&
    (candidate.status === "success" ||
      (candidate.status === "error" && typeof candidate.message === "string"))
  );
}

function isBlobLike(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number"
  );
}

function isInlineResourceUrl(url: string): boolean {
  return /^(?:data|blob):/i.test(url);
}

function resolvedFetchableResourceUrl(
  rawUrl: string,
  baseUrl: string,
): string | null {
  const trimmed = rawUrl.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("#") ||
    isInlineResourceUrl(trimmed) ||
    !URL.canParse(trimmed, baseUrl)
  ) {
    return null;
  }
  const url = new URL(trimmed, baseUrl);
  return url.protocol === "http:" || url.protocol === "https:"
    ? url.toString()
    : null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  const reader = new FileReader();
  const deferred = createDeferredPromise<string>(AbortSignal.any([]));
  reader.addEventListener(
    "load",
    () => {
      if (typeof reader.result === "string") {
        deferred.resolve(reader.result);
        return;
      }
      deferred.reject(new Error("Image did not encode as a data URL"));
    },
    { once: true },
  );
  reader.addEventListener(
    "error",
    () => {
      deferred.reject(reader.error ?? new Error("Image data URL read failed"));
    },
    { once: true },
  );
  reader.readAsDataURL(blob);
  return deferred.promise;
}

async function fetchResourceAsDataUrl(
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await settle(
    fetch(readablePresentationResourceUrl(url), {
      cache: "reload",
      mode: "cors",
      signal,
    }),
    signal,
  );
  if (!response.ok || !response.value.ok) {
    return null;
  }
  const dataUrl = await settle(
    blobToDataUrl(await response.value.blob()),
    signal,
  );
  return dataUrl.ok ? dataUrl.value : null;
}

type ResourceDataUrlCache = Map<string, Promise<string | null>>;

function cachedResourceDataUrl(
  cache: ResourceDataUrlCache,
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  const cached = cache.get(url);
  if (cached) {
    return cached;
  }
  const dataUrl = fetchResourceAsDataUrl(url, signal);
  cache.set(url, dataUrl);
  return dataUrl;
}

async function inlineImageSrc(
  image: HTMLImageElement,
  baseUrl: string,
  cache: ResourceDataUrlCache,
  signal: AbortSignal,
): Promise<void> {
  const src = image.getAttribute("src");
  if (!src) {
    return;
  }
  const url = resolvedFetchableResourceUrl(src, baseUrl);
  if (!url) {
    return;
  }
  const dataUrl = await cachedResourceDataUrl(cache, url, signal);
  if (dataUrl) {
    image.src = dataUrl;
  }
}

const CSS_URL_PATTERN = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")]+))\s*\)/g;

async function inlineCssResourceUrls(
  cssText: string,
  baseUrl: string,
  cache: ResourceDataUrlCache,
  signal: AbortSignal,
): Promise<string> {
  let inlinedCssText = "";
  let previousIndex = 0;
  for (const match of cssText.matchAll(CSS_URL_PATTERN)) {
    const matchedText = match[0];
    const rawUrl = match[1] ?? match[2] ?? match[3];
    const matchIndex = match.index;
    if (rawUrl === undefined || matchIndex === undefined) {
      continue;
    }

    inlinedCssText += cssText.slice(previousIndex, matchIndex);
    previousIndex = matchIndex + matchedText.length;

    const url = resolvedFetchableResourceUrl(rawUrl, baseUrl);
    const dataUrl = url
      ? await cachedResourceDataUrl(cache, url, signal)
      : null;
    inlinedCssText += dataUrl ? `url("${dataUrl}")` : matchedText;
  }
  return inlinedCssText + cssText.slice(previousIndex);
}

async function inlineCssAttributeImages(
  doc: Document,
  baseUrl: string,
  cache: ResourceDataUrlCache,
  signal: AbortSignal,
): Promise<void> {
  for (const element of doc.querySelectorAll("[style]")) {
    const style = element.getAttribute("style");
    if (!style) {
      continue;
    }
    element.setAttribute(
      "style",
      await inlineCssResourceUrls(style, baseUrl, cache, signal),
    );
  }
}

async function inlineStyleElementImages(
  doc: Document,
  baseUrl: string,
  cache: ResourceDataUrlCache,
  signal: AbortSignal,
): Promise<void> {
  for (const style of doc.querySelectorAll("style")) {
    style.textContent = await inlineCssResourceUrls(
      style.textContent ?? "",
      baseUrl,
      cache,
      signal,
    );
  }
}

async function inlineFetchableImages(
  doc: Document,
  baseUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const cache: ResourceDataUrlCache = new Map();
  await Promise.all([
    Promise.all(
      Array.from(doc.querySelectorAll("img")).map(async (image) => {
        await inlineImageSrc(image, baseUrl, cache, signal);
      }),
    ),
    inlineCssAttributeImages(doc, baseUrl, cache, signal),
    inlineStyleElementImages(doc, baseUrl, cache, signal),
  ]);
}

function createExportBootstrapScript(options: DomToPptxOptions): string {
  return `
(() => {
  const options = ${JSON.stringify(options)};
  const scriptUrl = ${JSON.stringify(domToPptxScriptUrl())};
  const slideSelectors = ${JSON.stringify(SLIDE_SELECTORS)};
  const fontReadyTimeoutMs = ${JSON.stringify(EXPORT_FONT_READY_TIMEOUT_MS)};

  const post = (message) => {
    window.parent.postMessage({
      type: "vm0-presentation-pptx-export",
      ...message,
    }, "*");
  };

  const settle = async (promise) => {
    try {
      await promise;
    } catch {
      return;
    }
  };

  const waitForFonts = async () => {
    if (!document.fonts?.ready) {
      return;
    }
    const timeout = new Promise((resolve) => {
      window.setTimeout(resolve, fontReadyTimeoutMs);
    });
    await Promise.race([settle(document.fonts.ready), timeout]);
  };

  const loadScript = (src) => {
    return new Promise((resolve, reject) => {
      const existing = Array.from(document.scripts).find((script) => {
        return script.src === src;
      });
      if (existing) {
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = src;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error("dom-to-pptx failed to load")),
        { once: true },
      );
      document.head.append(script);
    });
  };
`;
}

function createExportSlideScript(): string {
  return `
  const selectSlideNodes = () => {
    for (const selector of slideSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length > 0) {
        return nodes;
      }
    }
    return document.body ? [document.body] : [];
  };

  const revealSlideNodes = (nodes) => {
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      node.style.setProperty("display", "block", "important");
      node.style.setProperty("visibility", "visible", "important");
      node.style.setProperty("opacity", "1", "important");
      node.style.setProperty("clip", "auto", "important");
      node.style.setProperty("clip-path", "none", "important");
      node.style.setProperty("pointer-events", "none", "important");
      node.removeAttribute("hidden");
      node.setAttribute("aria-hidden", "false");
      for (const ancestor of ancestorsUntilBody(node)) {
        ancestor.style.setProperty("visibility", "visible", "important");
        ancestor.style.setProperty("opacity", "1", "important");
      }
    }
  };

  const ancestorsUntilBody = (node) => {
    const ancestors = [];
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.body) {
      ancestors.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    return ancestors;
  };

  const waitForImages = async (nodes) => {
    const images = nodes.flatMap((node) => {
      const nested = Array.from(node.querySelectorAll("img"));
      return node instanceof HTMLImageElement ? [node, ...nested] : nested;
    });

    await Promise.all(
      images.map(async (image) => {
        if (image.complete && image.naturalWidth > 0) {
          return;
        }
        if (typeof image.decode === "function") {
          await settle(image.decode());
          return;
        }
        await new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        });
      }),
    );
  };
`;
}

function createExportReadinessScript(): string {
  return `
  const getFiniteAnimations = (nodes) => {
    const animations = nodes.flatMap((node) => {
      if (typeof node.getAnimations !== "function") {
        return [];
      }
      return node.getAnimations({ subtree: true });
    });
    return animations.filter((animation) => {
      const effect = animation.effect;
      if (!effect || typeof effect.getTiming !== "function") {
        return false;
      }
      const timing = effect.getTiming();
      return timing.iterations !== Infinity;
    });
  };

  const animationTarget = (animation) => {
    const effect = animation.effect;
    return effect && "target" in effect ? effect.target : null;
  };

  const freezeAnimationsAtFinalFrame = (nodes) => {
    for (const animation of getFiniteAnimations(nodes)) {
      const effect = animation.effect;
      if (!effect || typeof effect.getComputedTiming !== "function") {
        continue;
      }
      const timing = effect.getComputedTiming();
      const endTime = Number.isFinite(timing.endTime)
        ? timing.endTime
        : timing.activeDuration;
      if (!Number.isFinite(endTime) || endTime <= 0) {
        continue;
      }
      animation.currentTime = endTime;
      animation.pause();
      if (typeof animation.commitStyles === "function") {
        try {
          animation.commitStyles();
        } catch {
          continue;
        }
      }
    }
  };

  const forceRevealAnimatedContent = (nodes) => {
    document.body.classList.remove("motion-ready");
    document.body.classList.add("low-power", "export-ready");
    const animationTargets = getFiniteAnimations(nodes)
      .map(animationTarget)
      .filter((target) => {
        return target instanceof HTMLElement;
      });
    for (const node of nodes) {
      const animatedNodes = [
        ...(node.matches("[data-anim]") ? [node] : []),
        ...Array.from(node.querySelectorAll("[data-anim]")),
        ...animationTargets,
      ];
      for (const animatedNode of animatedNodes) {
        animatedNode.style.setProperty("opacity", "1", "important");
        animatedNode.style.setProperty("transform", "none", "important");
      }
    }
  };

  const waitForExportReadiness = async (nodes) => {
    await Promise.all([
      waitForFonts(),
      waitForImages(nodes),
    ]);
    freezeAnimationsAtFinalFrame(nodes);
    forceRevealAnimatedContent(nodes);
  };
`;
}

function createExportRunnerScript(): string {
  return `
  void (async () => {
    await loadScript(scriptUrl);
    if (!window.domToPptx?.exportToPptx) {
      throw new Error("dom-to-pptx did not initialize");
    }
    const nodes = selectSlideNodes();
    if (nodes.length === 0) {
      throw new Error("Presentation HTML has no exportable content");
    }
    revealSlideNodes(nodes);
    await waitForExportReadiness(nodes);
    const blob = await window.domToPptx.exportToPptx(nodes, options);
    post({ status: "success", blob });
  })().catch((error) => {
    post({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
})();
`;
}

function createExportScript(options: DomToPptxOptions): string {
  return [
    createExportBootstrapScript(options),
    createExportSlideScript(),
    createExportReadinessScript(),
    createExportRunnerScript(),
  ].join("");
}

async function htmlWithExportScript(
  doc: Document,
  baseUrl: string,
  options: DomToPptxOptions,
  signal: AbortSignal,
): Promise<string> {
  await inlineFetchableImages(doc, baseUrl, signal);
  for (const script of doc.querySelectorAll("script")) {
    script.remove();
  }
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const base = doc.createElement("base");
  base.href = baseUrl;
  doc.head.prepend(base);
  const script = doc.createElement("script");
  script.textContent = createExportScript(options);
  doc.body.append(script);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function createExportFrame(html: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.title = "Presentation PPTX export";
  frame.setAttribute("sandbox", "allow-scripts allow-downloads");
  frame.style.position = "fixed";
  frame.style.left = "-200vw";
  frame.style.top = "0";
  frame.style.width = "1920px";
  frame.style.height = "1080px";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.style.zIndex = "-1";
  frame.srcdoc = html;
  document.body.append(frame);
  return frame;
}

function waitForExportFrameMessage(
  frame: HTMLIFrameElement,
  signal: AbortSignal,
): Promise<Blob> {
  const deferred = createDeferredPromise<Blob>(signal);
  const onMessage = (event: MessageEvent<unknown>) => {
    if (
      event.source !== frame.contentWindow ||
      !isExportFrameMessage(event.data) ||
      deferred.settled()
    ) {
      return;
    }
    if (event.data.status === "success") {
      if (isBlobLike(event.data.blob)) {
        deferred.resolve(event.data.blob);
        return;
      }
      deferred.reject(new Error("dom-to-pptx did not return a PPTX blob"));
      return;
    }
    deferred.reject(new Error(event.data.message));
  };
  window.addEventListener("message", onMessage);
  return withCleanup(deferred.promise, () => {
    window.removeEventListener("message", onMessage);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function parseDeckMetadata(doc: Document): DeckMetadata {
  const script = doc.getElementById(METADATA_SCRIPT_ID);
  if (!script?.textContent) {
    return {};
  }
  const parsed = jsonParseOr<unknown>(script.textContent, null);
  if (!isRecord(parsed) || !isRecord(parsed.slides)) {
    return {};
  }
  const slides: Record<string, DeckMetadataSlide> = {};
  for (const [slideId, value] of Object.entries(parsed.slides)) {
    if (!isRecord(value)) {
      continue;
    }
    const notes = value.speakerNotes;
    slides[slideId] = typeof notes === "string" ? { speakerNotes: notes } : {};
  }
  return { slides };
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

function slideIdForElement(slide: Element, index: number): string {
  return slide instanceof HTMLElement
    ? (slide.dataset.slideId ?? `slide-${index + 1}`)
    : `slide-${index + 1}`;
}

export function presentationSpeakerNotesFromHtml(
  html: string,
): readonly PresentationPptxSpeakerNote[] {
  return presentationSpeakerNotesFromDocument(parseHtml(html));
}

function presentationSpeakerNotesFromDocument(
  doc: Document,
): readonly PresentationPptxSpeakerNote[] {
  const metadata = parseDeckMetadata(doc);
  return selectSlideElements(doc).map((slide, index) => {
    const slideId = slideIdForElement(slide, index);
    return {
      slideNumber: index + 1,
      notes: metadata.slides?.[slideId]?.speakerNotes ?? "",
    };
  });
}

function serializeXml(doc: Document): string {
  return new XMLSerializer().serializeToString(doc);
}

function parseXml(xml: string, title: string): Document {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`${title} is not valid XML`);
  }
  return doc;
}

async function zipText(zip: JSZip, path: string): Promise<string | null> {
  return (await zip.file(path)?.async("string")) ?? null;
}

function xmlTagAttribute(tag: string, attribute: string): string | null {
  const prefix = `${attribute}="`;
  const start = tag.indexOf(prefix);
  if (start === -1) {
    return null;
  }
  const valueStart = start + prefix.length;
  const valueEnd = tag.indexOf('"', valueStart);
  return valueEnd === -1 ? null : tag.slice(valueStart, valueEnd);
}

async function presentationSlideNumbers(
  zip: JSZip,
): Promise<readonly number[]> {
  const [presentationXml, relationshipsXml] = await Promise.all([
    zipText(zip, PRESENTATION_PATH),
    zipText(zip, PRESENTATION_RELS_PATH),
  ]);
  if (!presentationXml || !relationshipsXml) {
    throw new Error("PPTX presentation structure is missing slide metadata");
  }
  const slideTargetsByRelationshipId = new Map(
    Array.from(relationshipsXml.matchAll(/<Relationship\b[^>]*\/?>/g))
      .map((match) => {
        const relationship = match[0];
        const id = xmlTagAttribute(relationship, "Id");
        const type = xmlTagAttribute(relationship, "Type");
        const target = xmlTagAttribute(relationship, "Target");
        if (
          !id ||
          type !==
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ||
          !target
        ) {
          return null;
        }
        return [id, target] as const;
      })
      .filter((entry): entry is readonly [string, string] => {
        return entry !== null;
      }),
  );
  return Array.from(
    presentationXml.matchAll(/<(?:[\w.-]+:)?sldId\b[^>]*\br:id="([^"]+)"/g),
  )
    .map((slideIdMatch) => {
      const relationshipId = slideIdMatch[1];
      const target = relationshipId
        ? slideTargetsByRelationshipId.get(relationshipId)
        : null;
      const slideTargetMatch = target ? /slide(\d+)\.xml$/.exec(target) : null;
      return slideTargetMatch ? Number(slideTargetMatch[1]) : null;
    })
    .filter((slideNumber): slideNumber is number => {
      return slideNumber !== null;
    });
}

function relationshipIdNumber(value: string): number | null {
  const match = /^rId(\d+)$/.exec(value);
  return match ? Number(match[1]) : null;
}

function nextRelationshipId(doc: Document): string {
  const max = Array.from(doc.getElementsByTagName("Relationship")).reduce(
    (current, rel) => {
      const id = rel.getAttribute("Id");
      const number = id ? relationshipIdNumber(id) : null;
      return number && number > current ? number : current;
    },
    0,
  );
  return `rId${max + 1}`;
}

function removeRelationshipsByType(doc: Document, type: string): void {
  for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
    if (rel.getAttribute("Type") === type) {
      rel.remove();
    }
  }
}

function addRelationship(params: {
  readonly doc: Document;
  readonly id: string;
  readonly target: string;
  readonly type: string;
}): void {
  const relationships = params.doc.documentElement;
  const rel = params.doc.createElementNS(
    PACKAGE_RELATIONSHIPS_NS,
    "Relationship",
  );
  rel.setAttribute("Id", params.id);
  rel.setAttribute("Type", params.type);
  rel.setAttribute("Target", params.target);
  relationships.append(rel);
}

function ensureContentTypeOverride(params: {
  readonly contentType: string;
  readonly doc: Document;
  readonly partName: string;
}): void {
  const existing = Array.from(params.doc.getElementsByTagName("Override")).some(
    (override) => {
      return override.getAttribute("PartName") === params.partName;
    },
  );
  if (existing) {
    return;
  }
  const override = params.doc.createElementNS(CONTENT_TYPES_NS, "Override");
  override.setAttribute("PartName", params.partName);
  override.setAttribute("ContentType", params.contentType);
  params.doc.documentElement.append(override);
}

async function ensureNotesContentTypes(
  zip: JSZip,
  slideNumbers: readonly number[],
): Promise<void> {
  const xml = await zipText(zip, CONTENT_TYPES_PATH);
  if (!xml) {
    throw new Error("PPTX content types file is missing");
  }
  const doc = parseXml(xml, CONTENT_TYPES_PATH);
  ensureContentTypeOverride({
    contentType: NOTES_MASTER_CONTENT_TYPE,
    doc,
    partName: "/ppt/notesMasters/notesMaster1.xml",
  });
  for (const slideNumber of slideNumbers) {
    ensureContentTypeOverride({
      contentType: NOTES_SLIDE_CONTENT_TYPE,
      doc,
      partName: `/ppt/notesSlides/notesSlide${slideNumber}.xml`,
    });
  }
  zip.file(CONTENT_TYPES_PATH, serializeXml(doc));
}

async function ensurePresentationNotesMasterRelationship(
  zip: JSZip,
): Promise<string> {
  const xml = await zipText(zip, PRESENTATION_RELS_PATH);
  if (!xml) {
    throw new Error("PPTX presentation relationships file is missing");
  }
  const doc = parseXml(xml, PRESENTATION_RELS_PATH);
  const existing = Array.from(doc.getElementsByTagName("Relationship")).find(
    (rel) => {
      return (
        rel.getAttribute("Type") === NOTES_MASTER_REL_TYPE &&
        rel.getAttribute("Target") === NOTES_MASTER_REL_TARGET
      );
    },
  );
  if (existing) {
    const id = existing.getAttribute("Id");
    if (id) {
      return id;
    }
  }
  const id = nextRelationshipId(doc);
  addRelationship({
    doc,
    id,
    target: NOTES_MASTER_REL_TARGET,
    type: NOTES_MASTER_REL_TYPE,
  });
  zip.file(PRESENTATION_RELS_PATH, serializeXml(doc));
  return id;
}

function ensureNotesMasterIdList(doc: Document, relationshipId: string): void {
  const presentation = doc.documentElement;
  const existing = Array.from(presentation.childNodes).find((node) => {
    return node instanceof Element && node.localName === "notesMasterIdLst";
  });
  const list =
    existing instanceof Element
      ? existing
      : doc.createElementNS(PRESENTATION_NS, "p:notesMasterIdLst");
  let id: Element | undefined = Array.from(list.childNodes).find(
    (node): node is Element => {
      return node instanceof Element && node.localName === "notesMasterId";
    },
  );
  if (!id) {
    id = doc.createElementNS(PRESENTATION_NS, "p:notesMasterId");
    list.append(id);
  }
  id.setAttributeNS(RELATIONSHIP_NS, "r:id", relationshipId);
  if (!existing) {
    const sldIdLst = Array.from(presentation.childNodes).find((node) => {
      return node instanceof Element && node.localName === "sldIdLst";
    });
    if (sldIdLst) {
      if (sldIdLst.nextSibling) {
        sldIdLst.nextSibling.before(list);
      } else {
        presentation.append(list);
      }
      return;
    }
    presentation.append(list);
  }
}

function ensureNotesSize(doc: Document): void {
  const presentation = doc.documentElement;
  const existing = Array.from(presentation.childNodes).some((node) => {
    return node instanceof Element && node.localName === "notesSz";
  });
  if (existing) {
    return;
  }
  const notesSize = doc.createElementNS(PRESENTATION_NS, "p:notesSz");
  notesSize.setAttribute("cx", "6858000");
  notesSize.setAttribute("cy", "9144000");
  presentation.append(notesSize);
}

async function ensurePresentationNotesMetadata(
  zip: JSZip,
  relationshipId: string,
): Promise<void> {
  const xml = await zipText(zip, PRESENTATION_PATH);
  if (!xml) {
    throw new Error("PPTX presentation file is missing");
  }
  const doc = parseXml(xml, PRESENTATION_PATH);
  ensureNotesMasterIdList(doc, relationshipId);
  ensureNotesSize(doc);
  zip.file(PRESENTATION_PATH, serializeXml(doc));
}

async function ensureSlideNotesRelationship(
  zip: JSZip,
  slideNumber: number,
): Promise<void> {
  const path = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
  const xml = await zipText(zip, path);
  if (!xml) {
    return;
  }
  const doc = parseXml(xml, path);
  removeRelationshipsByType(doc, NOTES_SLIDE_REL_TYPE);
  addRelationship({
    doc,
    id: nextRelationshipId(doc),
    target: `../notesSlides/notesSlide${slideNumber}.xml`,
    type: NOTES_SLIDE_REL_TYPE,
  });
  zip.file(path, serializeXml(doc));
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function noteParagraphXml(notes: string): string {
  const lines = notes.split(/\r\n|\r|\n/);
  return lines
    .map((line) => {
      const text = xmlText(line);
      return `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${text}</a:t></a:r><a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
    })
    .join("");
}

function emptyGroupTransformXml(): string {
  return '<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>';
}

function notesMasterShapeTreeXml(): string {
  return [
    "<p:spTree>",
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    `<p:grpSpPr>${emptyGroupTransformXml()}</p:grpSpPr>`,
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>',
    "</p:spTree>",
  ].join("");
}

function notesMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="${DRAWING_NS}" xmlns:r="${RELATIONSHIP_NS}" xmlns:p="${PRESENTATION_NS}">
  <p:cSld>
    ${notesMasterShapeTreeXml()}
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:notesStyle><a:lvl1pPr algn="l"><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle>
</p:notesMaster>`;
}

function notesMasterRelationshipXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function notesSlideRelationshipXml(slideNumber: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}">
  <Relationship Id="rId1" Type="${NOTES_MASTER_REL_TYPE}" Target="../notesMasters/notesMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideNumber}.xml"/>
</Relationships>`;
}

function slideImagePlaceholderXml(): string {
  return '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>';
}

function noteBodyPlaceholderXml(notes: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${noteParagraphXml(notes)}</p:txBody></p:sp>`;
}

function slideNumberPlaceholderXml(displaySlideNumber: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder 3"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{CE5E9CC1-C706-0F49-92D6-E571CC5EEA8F}" type="slidenum"><a:rPr lang="en-US"/><a:t>${displaySlideNumber}</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}

function notesSlideShapeTreeXml(params: {
  readonly displaySlideNumber: number;
  readonly notes: string;
}): string {
  return [
    "<p:spTree>",
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    `<p:grpSpPr>${emptyGroupTransformXml()}</p:grpSpPr>`,
    slideImagePlaceholderXml(),
    noteBodyPlaceholderXml(params.notes),
    slideNumberPlaceholderXml(params.displaySlideNumber),
    "</p:spTree>",
  ].join("");
}

function notesSlideXml(params: {
  readonly displaySlideNumber: number;
  readonly notes: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="${DRAWING_NS}" xmlns:r="${RELATIONSHIP_NS}" xmlns:p="${PRESENTATION_NS}">
  <p:cSld>
    ${notesSlideShapeTreeXml(params)}
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:notes>`;
}

async function addSpeakerNotesToPptxBlob(params: {
  readonly blob: Blob;
  readonly notes: readonly PresentationPptxSpeakerNote[];
}): Promise<Blob> {
  const notesBySlide = new Map(
    params.notes.map((note) => {
      return [note.slideNumber, note.notes];
    }),
  );
  const hasAnyNotes = Array.from(notesBySlide.values()).some((note) => {
    return note.trim().length > 0;
  });
  if (!hasAnyNotes) {
    return params.blob;
  }
  const zip = await JSZip.loadAsync(params.blob);
  const slideNumbers = await presentationSlideNumbers(zip);
  if (slideNumbers.length === 0) {
    return params.blob;
  }
  await ensureNotesContentTypes(zip, slideNumbers);
  const relationshipId = await ensurePresentationNotesMasterRelationship(zip);
  await ensurePresentationNotesMetadata(zip, relationshipId);
  zip.file("ppt/notesMasters/notesMaster1.xml", notesMasterXml());
  zip.file(
    "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    notesMasterRelationshipXml(),
  );
  for (let index = 0; index < slideNumbers.length; index += 1) {
    const slideNumber = slideNumbers[index];
    const displaySlideNumber = index + 1;
    await ensureSlideNotesRelationship(zip, slideNumber);
    zip.file(
      `ppt/notesSlides/notesSlide${slideNumber}.xml`,
      notesSlideXml({
        displaySlideNumber,
        notes: notesBySlide.get(displaySlideNumber) ?? "",
      }),
    );
    zip.file(
      `ppt/notesSlides/_rels/notesSlide${slideNumber}.xml.rels`,
      notesSlideRelationshipXml(slideNumber),
    );
  }
  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function downloadPresentationHtmlPptx(params: {
  readonly filename: string;
  readonly signal: AbortSignal;
  readonly url: string;
}): Promise<void> {
  const htmlUrl = publicAttachmentUrl(params.url);
  const response = await fetch(readablePresentationResourceUrl(htmlUrl), {
    cache: "reload",
    mode: "cors",
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch presentation HTML (${response.status})`);
  }
  const html = await response.text();
  params.signal.throwIfAborted();
  await downloadPresentationHtmlStringPptx({
    baseUrl: htmlUrl,
    filename: params.filename,
    html,
    signal: params.signal,
  });
}

export async function downloadPresentationHtmlStringPptx(params: {
  readonly baseUrl: string;
  readonly filename: string;
  readonly html: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const options = {
    fileName: pptxFilename(params.filename),
    skipDownload: true,
    svgAsVector: true,
    layout: "LAYOUT_WIDE",
  } satisfies DomToPptxOptions;
  const doc = parseHtml(params.html);
  const notes = presentationSpeakerNotesFromDocument(doc);
  const exportHtml = await htmlWithExportScript(
    doc,
    params.baseUrl,
    options,
    params.signal,
  );
  const frame = createExportFrame(exportHtml);
  const pptxBlob = await withCleanup(
    waitForExportFrameMessage(frame, params.signal),
    () => {
      frame.remove();
    },
  );
  params.signal.throwIfAborted();
  const finalBlob = await addSpeakerNotesToPptxBlob({
    blob: pptxBlob,
    notes,
  });
  params.signal.throwIfAborted();
  downloadBlob(finalBlob, options.fileName);
}
