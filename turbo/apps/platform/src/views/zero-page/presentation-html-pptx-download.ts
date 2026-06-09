import { publicAttachmentUrl } from "./zero-attachment-url.ts";
import domToPptxBundleUrl from "../../../node_modules/dom-to-pptx/dist/dom-to-pptx.bundle.js?url";
import {
  createDeferredPromise,
  settle,
  withCleanup,
} from "../../signals/utils.ts";

const EXPORT_FONT_READY_TIMEOUT_MS = 800;
const DEV_ARTIFACT_FETCH_PROXY_PATH = "/__vm0-dev-artifact-fetch";
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
  readonly svgAsVector: boolean;
};

type ExportFrameMessage =
  | {
      readonly status: "success";
      readonly type: "vm0-presentation-pptx-export";
    }
  | {
      readonly message: string;
      readonly status: "error";
      readonly type: "vm0-presentation-pptx-export";
    };

function pptxFilename(filename: string): string {
  const base = filename
    .replace(/[\\/]/g, "-")
    .replace(/\.(html?|xhtml)$/i, "")
    .trim();
  return `${base || "presentation"}.pptx`;
}

function domToPptxScriptUrl(): string {
  return new URL(domToPptxBundleUrl, window.location.origin).toString();
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
    await window.domToPptx.exportToPptx(nodes, options);
    post({ status: "success" });
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
  html: string,
  baseUrl: string,
  options: DomToPptxOptions,
  signal: AbortSignal,
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
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
): Promise<void> {
  const deferred = createDeferredPromise<void>(signal);
  const onMessage = (event: MessageEvent<unknown>) => {
    if (
      event.source !== frame.contentWindow ||
      !isExportFrameMessage(event.data) ||
      deferred.settled()
    ) {
      return;
    }
    if (event.data.status === "success") {
      deferred.resolve();
      return;
    }
    deferred.reject(new Error(event.data.message));
  };
  window.addEventListener("message", onMessage);
  return withCleanup(deferred.promise, () => {
    window.removeEventListener("message", onMessage);
  });
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
    svgAsVector: true,
    layout: "LAYOUT_WIDE",
  } satisfies DomToPptxOptions;
  const exportHtml = await htmlWithExportScript(
    params.html,
    params.baseUrl,
    options,
    params.signal,
  );
  const frame = createExportFrame(exportHtml);
  await withCleanup(waitForExportFrameMessage(frame, params.signal), () => {
    frame.remove();
  });
}
