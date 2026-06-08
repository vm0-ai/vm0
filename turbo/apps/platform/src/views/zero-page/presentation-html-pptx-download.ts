import { publicAttachmentUrl } from "./zero-attachment-url.ts";
import {
  createDeferredPromise,
  settle,
  withCleanup,
} from "../../signals/utils.ts";

const DOM_TO_PPTX_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/dom-to-pptx@1.1.10/dist/dom-to-pptx.bundle.js";
const EXPORT_SETTLE_DELAY_MS = 1_200;
const EXPORT_ANIMATION_TIMEOUT_MS = 10_000;
const SLIDE_SELECTORS = [
  "[data-vm0-slide]",
  "[data-slide]",
  ".slide",
  "section",
] as const;

type DomToPptxOptions = {
  readonly fileName: string;
  readonly layout: "LAYOUT_WIDE";
  readonly svgAsVector: boolean;
};

type DomToPptx = {
  readonly exportToPptx: (
    nodes: readonly Element[],
    options: DomToPptxOptions,
  ) => Promise<void>;
};

function isDomToPptx(value: unknown): value is DomToPptx {
  return (
    typeof value === "object" &&
    value !== null &&
    "exportToPptx" in value &&
    typeof (value as { readonly exportToPptx: unknown }).exportToPptx ===
      "function"
  );
}

function domToPptxFromWindow(frameWindow: Window): DomToPptx | undefined {
  const value = (frameWindow as unknown as { readonly domToPptx?: unknown })
    .domToPptx;
  return isDomToPptx(value) ? value : undefined;
}

function pptxFilename(filename: string): string {
  const base = filename
    .replace(/[\\/]/g, "-")
    .replace(/\.(html?|xhtml)$/i, "")
    .trim();
  return `${base || "presentation"}.pptx`;
}

function abortError(): DOMException {
  return new DOMException("Presentation PPTX download aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function waitForFrameLoad(
  frame: HTMLIFrameElement,
  signal: AbortSignal,
): Promise<void> {
  const deferred = createDeferredPromise<void>(signal);
  const onLoad = () => {
    if (!deferred.settled()) {
      deferred.resolve();
    }
  };
  const onError = () => {
    if (!deferred.settled()) {
      deferred.reject(new Error("Presentation HTML preview failed to load"));
    }
  };
  frame.addEventListener("load", onLoad, { once: true });
  frame.addEventListener("error", onError, { once: true });
  return withCleanup(deferred.promise, () => {
    frame.removeEventListener("load", onLoad);
    frame.removeEventListener("error", onError);
  });
}

function loadScriptInFrame(
  frameWindow: Window,
  src: string,
  signal: AbortSignal,
): Promise<void> {
  const existing = Array.from(frameWindow.document.scripts).find((script) => {
    return script.src === src;
  });
  if (existing) {
    return Promise.resolve();
  }

  const deferred = createDeferredPromise<void>(signal);
  const script = frameWindow.document.createElement("script");
  const onLoad = () => {
    if (!deferred.settled()) {
      deferred.resolve();
    }
  };
  const onError = () => {
    if (!deferred.settled()) {
      deferred.reject(new Error("dom-to-pptx failed to load"));
    }
  };
  script.src = src;
  script.addEventListener("load", onLoad, { once: true });
  script.addEventListener("error", onError, { once: true });
  frameWindow.document.head.append(script);
  return withCleanup(deferred.promise, () => {
    script.removeEventListener("load", onLoad);
    script.removeEventListener("error", onError);
  });
}

async function ensureFrameDomToPptx(
  frameWindow: Window,
  signal: AbortSignal,
): Promise<DomToPptx> {
  const existing = domToPptxFromWindow(frameWindow);
  if (existing) {
    return existing;
  }

  await loadScriptInFrame(frameWindow, DOM_TO_PPTX_SCRIPT_URL, signal);
  const loaded = domToPptxFromWindow(frameWindow);
  if (!loaded) {
    throw new Error("dom-to-pptx did not initialize");
  }
  return loaded;
}

function htmlWithBaseUrl(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const script of doc.querySelectorAll("script")) {
    script.remove();
  }
  const base = doc.createElement("base");
  base.href = baseUrl;
  doc.head.prepend(base);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function createExportFrame(html: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.title = "Presentation PPTX export";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.style.position = "fixed";
  frame.style.left = "-200vw";
  frame.style.top = "0";
  frame.style.width = "1440px";
  frame.style.height = "900px";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.style.zIndex = "-1";
  frame.srcdoc = html;
  document.body.append(frame);
  return frame;
}

function selectSlideNodes(doc: Document): readonly Element[] {
  for (const selector of SLIDE_SELECTORS) {
    const nodes = Array.from(doc.querySelectorAll(selector));
    if (nodes.length > 0) {
      return nodes;
    }
  }
  return doc.body ? [doc.body] : [];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const deferred = createDeferredPromise<void>(signal);
  const timeout = window.setTimeout(() => {
    if (!deferred.settled()) {
      deferred.resolve();
    }
  }, ms);
  return withCleanup(deferred.promise, () => {
    window.clearTimeout(timeout);
  });
}

async function waitForImages(
  nodes: readonly Element[],
  signal: AbortSignal,
): Promise<void> {
  const images = nodes.flatMap((node) => {
    const nested = Array.from(node.querySelectorAll("img"));
    return node instanceof HTMLImageElement ? [node, ...nested] : nested;
  });

  await Promise.all(
    images.map(async (image) => {
      throwIfAborted(signal);
      if (image.complete && image.naturalWidth > 0) {
        return;
      }
      if (typeof image.decode === "function") {
        await settle(image.decode());
        return;
      }
      const deferred = createDeferredPromise<void>(signal);
      const onSettled = () => {
        if (!deferred.settled()) {
          deferred.resolve();
        }
      };
      image.addEventListener("load", onSettled, { once: true });
      image.addEventListener("error", onSettled, { once: true });
      await withCleanup(deferred.promise, () => {
        image.removeEventListener("load", onSettled);
        image.removeEventListener("error", onSettled);
      });
    }),
  );
}

async function waitForFiniteAnimations(
  nodes: readonly Element[],
  timeoutMs: number,
): Promise<void> {
  const animations = nodes.flatMap((node) => {
    return node.getAnimations({ subtree: true });
  });
  const finiteAnimations = animations.filter((animation) => {
    const effect = animation.effect;
    if (!effect) {
      return false;
    }
    const timing = effect.getTiming();
    return timing.iterations !== Infinity && animation.playState !== "finished";
  });
  if (finiteAnimations.length === 0) {
    return;
  }
  await Promise.race([
    Promise.all(
      finiteAnimations.map(async (animation) => {
        await settle(animation.finished);
      }),
    ),
    sleep(timeoutMs, AbortSignal.any([])),
  ]);
}

function forceRevealAnimatedContent(nodes: readonly Element[]): void {
  const documents = new Set(
    nodes.map((node) => {
      return node.ownerDocument;
    }),
  );
  for (const doc of documents) {
    doc.body.classList.remove("motion-ready");
    doc.body.classList.add("low-power", "export-ready");
  }

  for (const node of nodes) {
    const animatedNodes = [
      ...(node.matches("[data-anim]") ? [node] : []),
      ...Array.from(node.querySelectorAll("[data-anim]")),
    ];
    for (const animatedNode of animatedNodes) {
      const element = animatedNode as HTMLElement;
      element.style.setProperty("opacity", "1", "important");
      element.style.setProperty("transform", "none", "important");
    }
  }
}

async function waitForExportReadiness(
  nodes: readonly Element[],
  signal: AbortSignal,
): Promise<void> {
  const fontReadiness = Array.from(
    new Set(
      nodes.map((node) => {
        return node.ownerDocument;
      }),
    ),
  ).map((doc) => {
    return doc.fonts?.ready ?? Promise.resolve();
  });

  await Promise.all([
    ...fontReadiness,
    waitForImages(nodes, signal),
    waitForFiniteAnimations(nodes, EXPORT_ANIMATION_TIMEOUT_MS),
  ]);
  throwIfAborted(signal);
  await sleep(EXPORT_SETTLE_DELAY_MS, signal);
  forceRevealAnimatedContent(nodes);
}

export async function downloadPresentationHtmlPptx(params: {
  readonly filename: string;
  readonly signal: AbortSignal;
  readonly url: string;
}): Promise<void> {
  const htmlUrl = publicAttachmentUrl(params.url);
  const response = await fetch(htmlUrl, {
    cache: "reload",
    mode: "cors",
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch presentation HTML (${response.status})`);
  }
  const html = await response.text();
  throwIfAborted(params.signal);

  const frame = createExportFrame(htmlWithBaseUrl(html, htmlUrl));
  await withCleanup(
    (async () => {
      await waitForFrameLoad(frame, params.signal);
      const frameWindow = frame.contentWindow;
      const frameDocument = frame.contentDocument;
      if (!frameWindow || !frameDocument) {
        throw new Error("Presentation export frame is unavailable");
      }

      const nodes = selectSlideNodes(frameDocument);
      if (nodes.length === 0) {
        throw new Error("Presentation HTML has no exportable content");
      }
      await waitForExportReadiness(nodes, params.signal);
      const domToPptx = await ensureFrameDomToPptx(frameWindow, params.signal);
      await domToPptx.exportToPptx(nodes, {
        fileName: pptxFilename(params.filename),
        svgAsVector: true,
        layout: "LAYOUT_WIDE",
      });
    })(),
    () => {
      frame.remove();
    },
  );
}
