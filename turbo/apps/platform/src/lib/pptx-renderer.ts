import {
  buildPresentation,
  parseZipLazyMedia,
  renderSlide,
  type PptxFiles,
  type PresentationData,
  type SlideHandle,
  type SlideRendererOptions,
} from "@aiden0z/pptx-renderer";
import { domToBlob } from "modern-screenshot";
import { animationFrame, delay } from "signal-timers";

import {
  createChildAbortController,
  createDeferredPromise,
  detach,
  onRejection,
  Reason,
  settle,
  withCleanup,
} from "../signals/utils.ts";

export const PPTX_PAGE_WIDTH = 1600;
export const PPTX_PAGE_HEIGHT = 900;

export const PPTX_RENDER_LIMITS = Object.freeze({
  maxSourceBytes: 100 * 1024 * 1024,
  maxPages: 100,
  maxZipEntries: 4000,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxMediaBytes: 192 * 1024 * 1024,
  zipConcurrency: 4,
  pageRenderConcurrency: 1,
  pageExportConcurrency: 2,
  maxConcurrentExportsPerSession: 1,
  resourceTimeoutMs: 30_000,
});

export type PptxRenderErrorCode =
  | "concurrency_limit"
  | "disposed"
  | "encrypted_file"
  | "export_failed"
  | "invalid_file"
  | "invalid_target"
  | "render_failed"
  | "resource_timeout"
  | "too_large"
  | "too_many_pages"
  | "unsupported_content"
  | "unsupported_format";

export type PptxUnsupportedFeature =
  | "emf"
  | "equation"
  | "external_image"
  | "macro"
  | "ole";

interface PptxRenderErrorOptions extends ErrorOptions {
  readonly feature?: PptxUnsupportedFeature;
  readonly pageIndex?: number;
}

export class PptxRenderError extends Error {
  readonly code: PptxRenderErrorCode;
  readonly feature: PptxUnsupportedFeature | undefined;
  readonly pageIndex: number | undefined;

  constructor(
    code: PptxRenderErrorCode,
    message: string,
    options: PptxRenderErrorOptions = {},
  ) {
    super(message, options);
    this.name = "PptxRenderError";
    this.code = code;
    this.feature = options.feature;
    this.pageIndex = options.pageIndex;
  }
}

export interface PptxSource {
  readonly data: ArrayBuffer | Blob;
  readonly filename: string;
}

export interface RenderPptxRequest {
  readonly source: PptxSource;
  readonly target: HTMLElement;
}

export interface PptxRenderedPage {
  /** Zero-based page index in source order. */
  readonly index: number;
  /** Fixed-size browser preview tree used directly for PNG export. */
  readonly element: HTMLElement;
}

export interface PptxRenderSession {
  readonly pageCount: number;
  readonly pages: readonly PptxRenderedPage[];
  exportPngs(signal: AbortSignal): Promise<readonly Blob[]>;
  dispose(): void;
}

interface UnsupportedRule {
  readonly feature: PptxUnsupportedFeature;
  readonly message: string;
  readonly pattern: RegExp;
}

const UNSUPPORTED_RULES: readonly UnsupportedRule[] = [
  {
    feature: "macro",
    message: "Macro-enabled PowerPoint files are not supported",
    pattern: /application\/vnd\.ms-powerpoint\.[^"<]*macroenabled/i,
  },
  {
    feature: "ole",
    message: "Embedded OLE objects are not supported",
    pattern: /<(?:\w+:)?oleObj\b|\/relationships\/oleObject(?:"|<)/i,
  },
  {
    feature: "equation",
    message: "Office Math equations are not supported",
    pattern: /<(?:\w+:)?oMath(?:Para)?(?:\s|>)/i,
  },
  {
    feature: "emf",
    message: "EMF image content is not supported",
    pattern: /(?:target|partname)="[^"]+\.emf(?:"|\?)|image\/(?:x-)?emf/i,
  },
];

const ZIP_SIGNATURES: ReadonlySet<string> = new Set([
  "PK\u0003\u0004",
  "PK\u0005\u0006",
  "PK\u0007\b",
]);
const OLE_SIGNATURE: readonly number[] = [
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
];
const CSS_IMAGE_URL_PATTERN =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/giu;
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

type PptxChartInstance =
  NonNullable<SlideRendererOptions["chartInstances"]> extends Set<
    infer Instance
  >
    ? Instance
    : never;
type PptxChartInstances = Set<PptxChartInstance>;

function sourceSize(data: ArrayBuffer | Blob): number {
  return data instanceof Blob ? data.size : data.byteLength;
}

async function readSource(source: PptxSource): Promise<ArrayBuffer> {
  const filename = source.filename.trim();
  if (!filename.toLowerCase().endsWith(".pptx")) {
    throw new PptxRenderError(
      "unsupported_format",
      "Only .pptx PowerPoint files are supported",
    );
  }

  const size = sourceSize(source.data);
  if (size > PPTX_RENDER_LIMITS.maxSourceBytes) {
    throw new PptxRenderError(
      "too_large",
      `PPTX source is ${size.toString()} bytes; the limit is ${PPTX_RENDER_LIMITS.maxSourceBytes.toString()} bytes`,
    );
  }
  if (size === 0) {
    throw new PptxRenderError("invalid_file", "The PPTX file is empty");
  }

  const buffer =
    source.data instanceof Blob
      ? await source.data.arrayBuffer()
      : source.data.slice(0);
  validateContainerSignature(buffer);
  return buffer;
}

function validateContainerSignature(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8));
  const isOleContainer = OLE_SIGNATURE.every((value, index) => {
    return bytes[index] === value;
  });
  if (isOleContainer) {
    throw new PptxRenderError(
      "encrypted_file",
      "Encrypted PPTX files are not supported",
    );
  }

  const signature = String.fromCharCode(...bytes.slice(0, 4));
  if (!ZIP_SIGNATURES.has(signature)) {
    throw new PptxRenderError(
      "invalid_file",
      "The file is not a valid PPTX ZIP container",
    );
  }
}

function* packageXml(files: PptxFiles): Generator<string> {
  yield files.contentTypes;
  yield files.presentation;
  yield files.presentationRels;
  if (files.tableStyles !== undefined) {
    yield files.tableStyles;
  }

  const maps = [
    files.slides,
    files.slideRels,
    files.slideLayouts,
    files.slideLayoutRels,
    files.slideMasters,
    files.slideMasterRels,
    files.charts,
    files.chartRels,
    files.chartStyles,
    files.chartColors,
    files.diagramDrawings,
  ];
  for (const map of maps) {
    if (map !== undefined) {
      yield* map.values();
    }
  }
}

function* relationshipXml(files: PptxFiles): Generator<string> {
  yield files.presentationRels;
  const maps = [
    files.slideRels,
    files.slideLayoutRels,
    files.slideMasterRels,
    files.chartRels,
  ];
  for (const map of maps) {
    if (map !== undefined) {
      yield* map.values();
    }
  }
}

function relationshipAttribute(
  relationship: Element,
  name: string,
): string | null {
  const normalizedName = name.toLowerCase();
  for (const attribute of relationship.attributes) {
    if (attribute.localName.toLowerCase() === normalizedName) {
      return attribute.value;
    }
  }
  return null;
}

function hasExternalImageRelationship(xml: string): boolean {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  for (const relationship of document.getElementsByTagName("*")) {
    if (relationship.localName !== "Relationship") {
      continue;
    }
    const targetMode = relationshipAttribute(relationship, "TargetMode");
    const type = relationshipAttribute(relationship, "Type");
    if (
      targetMode?.trim().toLowerCase() === "external" &&
      type?.trim().toLowerCase().endsWith("/relationships/image") === true
    ) {
      return true;
    }
  }
  return false;
}

function assertSupportedContent(files: PptxFiles): void {
  for (const rule of UNSUPPORTED_RULES) {
    for (const xml of packageXml(files)) {
      if (rule.pattern.test(xml)) {
        throw new PptxRenderError("unsupported_content", rule.message, {
          feature: rule.feature,
        });
      }
    }
  }

  for (const xml of relationshipXml(files)) {
    if (hasExternalImageRelationship(xml)) {
      throw new PptxRenderError(
        "unsupported_content",
        "Externally linked images are not supported",
        { feature: "external_image" },
      );
    }
  }
}

function mapParseError(error: unknown): PptxRenderError {
  if (error instanceof PptxRenderError) {
    return error;
  }
  if (
    error instanceof Error &&
    error.message.startsWith("PPTX zip limit exceeded:")
  ) {
    return new PptxRenderError(
      "too_large",
      `PPTX expanded content exceeds a browser rendering limit: ${error.message}`,
      { cause: error },
    );
  }
  return new PptxRenderError(
    "invalid_file",
    "The PPTX package could not be parsed",
    { cause: error },
  );
}

function waitForAbortablePromise<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  return withCleanup(Promise.race([promise, aborted.promise]), () => {
    if (!aborted.settled()) {
      aborted.reject(
        new DOMException("PPTX resource operation settled", "AbortError"),
      );
    }
  });
}

function waitWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutError: PptxRenderError,
): Promise<T> {
  signal.throwIfAborted();
  const deadlineController = createChildAbortController(signal);
  const deadlineSignal = deadlineController.signal;
  const operationPromise = operation(deadlineSignal);
  const waitPromise = waitForAbortablePromise(operationPromise, deadlineSignal);
  const waitForDeadline = async (): Promise<never> => {
    await delay(PPTX_RENDER_LIMITS.resourceTimeoutMs, {
      signal: deadlineSignal,
    });
    deadlineController.abort(timeoutError);
    throw timeoutError;
  };
  const deadlinePromise = waitForDeadline();
  return withCleanup(Promise.race([waitPromise, deadlinePromise]), () => {
    if (!deadlineSignal.aborted) {
      deadlineController.abort(
        new DOMException("PPTX resource operation settled", "AbortError"),
      );
    }
  });
}

async function nextPaint(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const deferred = createDeferredPromise<void>(signal);
  animationFrame(
    () => {
      if (!deferred.settled()) {
        deferred.resolve(undefined);
      }
    },
    { signal },
  );
  await deferred.promise;
  signal.throwIfAborted();
}

function imageSource(image: HTMLImageElement): string {
  return image.currentSrc || image.src;
}

function addImageSource(sources: Set<string>, source: string | null): void {
  const normalized = source?.trim();
  if (normalized) {
    sources.add(normalized);
  }
}

function collectPageImageSources(page: HTMLElement): {
  readonly elementsBySource: ReadonlyMap<string, HTMLImageElement>;
  readonly sources: ReadonlySet<string>;
} {
  const elementsBySource = new Map<string, HTMLImageElement>();
  const sources = new Set<string>();

  for (const image of page.querySelectorAll<HTMLImageElement>("img")) {
    const source = imageSource(image).trim();
    if (source) {
      sources.add(source);
      if (!elementsBySource.has(source)) {
        elementsBySource.set(source, image);
      }
    }
  }

  for (const image of page.querySelectorAll("svg image")) {
    addImageSource(sources, image.getAttribute("href"));
    addImageSource(sources, image.getAttributeNS(XLINK_NAMESPACE, "href"));
  }

  const view = page.ownerDocument.defaultView;
  if (view !== null) {
    const elements: Element[] = [page, ...page.querySelectorAll("*")];
    for (const element of elements) {
      const backgroundImage = view.getComputedStyle(element).backgroundImage;
      for (const match of backgroundImage.matchAll(CSS_IMAGE_URL_PATTERN)) {
        addImageSource(sources, match[1] ?? match[2] ?? match[3] ?? null);
      }
    }
  }

  return { elementsBySource, sources };
}

function imageLoadError(): Error {
  return new Error("A PPTX image resource could not be decoded");
}

async function waitForImageLoadFallback(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<void> {
  if (image.complete) {
    if (image.naturalWidth === 0) {
      throw imageLoadError();
    }
    return;
  }

  const deferred = createDeferredPromise<void>(signal);
  const onLoad = () => {
    if (!deferred.settled()) {
      deferred.resolve(undefined);
    }
  };
  const onError = () => {
    if (!deferred.settled()) {
      deferred.reject(imageLoadError());
    }
  };
  image.addEventListener("load", onLoad, { once: true });
  image.addEventListener("error", onError, { once: true });
  if (image.complete) {
    if (image.naturalWidth === 0) {
      onError();
    } else {
      onLoad();
    }
  }

  await withCleanup(deferred.promise, () => {
    image.removeEventListener("load", onLoad);
    image.removeEventListener("error", onError);
  });
}

async function decodeImage(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (image.decode === undefined) {
    await waitForImageLoadFallback(image, signal);
    return;
  }

  const decodeResult = await settle(
    waitForAbortablePromise(image.decode(), signal),
    signal,
  );
  if (!decodeResult.ok) {
    throw new Error("A PPTX image resource could not be decoded", {
      cause: decodeResult.error,
    });
  }
  signal.throwIfAborted();
}

async function waitForPageImages(
  page: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const { elementsBySource, sources } = collectPageImageSources(page);
  await Promise.all(
    Array.from(sources, (source) => {
      const renderedImage = elementsBySource.get(source);
      if (renderedImage !== undefined) {
        return decodeImage(renderedImage, signal);
      }
      const probe = page.ownerDocument.createElement("img");
      probe.decoding = "async";
      probe.loading = "eager";
      probe.src = source;
      return withCleanup(decodeImage(probe, signal), () => {
        probe.removeAttribute("src");
      });
    }),
  );
}

function chartAnimationFinished(chart: PptxChartInstance): boolean {
  return chart.isDisposed() || chart.getZr().animation.isFinished();
}

async function waitForChartAnimation(
  chart: PptxChartInstance,
  signal: AbortSignal,
): Promise<void> {
  if (chartAnimationFinished(chart)) {
    return;
  }

  const deferred = createDeferredPromise<void>(signal);
  const onFinished = () => {
    if (!deferred.settled()) {
      deferred.resolve(undefined);
    }
  };
  chart.on("finished", onFinished);
  if (chartAnimationFinished(chart)) {
    onFinished();
  }
  await withCleanup(deferred.promise, () => {
    chart.off("finished", onFinished);
  });
}

async function waitForChartAnimations(
  chartInstances: PptxChartInstances,
  signal: AbortSignal,
): Promise<void> {
  await Promise.all(
    Array.from(chartInstances, (chart) => {
      return waitForChartAnimation(chart, signal);
    }),
  );
}

async function waitForPageResources(
  page: HTMLElement,
  handle: SlideHandle,
  chartInstances: PptxChartInstances,
  pageIndex: number,
  signal: AbortSignal,
): Promise<void> {
  await waitWithDeadline(
    async (deadlineSignal) => {
      await waitForAbortablePromise(handle.ready, deadlineSignal);
      await Promise.all([
        waitForAbortablePromise(document.fonts.ready, deadlineSignal),
        waitForPageImages(page, deadlineSignal),
        waitForChartAnimations(chartInstances, deadlineSignal),
      ]);
      await nextPaint(deadlineSignal);
      await nextPaint(deadlineSignal);
    },
    signal,
    new PptxRenderError(
      "resource_timeout",
      `Page ${(pageIndex + 1).toString()} resources did not become ready within ${PPTX_RENDER_LIMITS.resourceTimeoutMs.toString()} ms`,
      { pageIndex },
    ),
  );
}

function createPageSurface(
  presentation: PresentationData,
  handle: SlideHandle,
  index: number,
): HTMLElement {
  const page = document.createElement("div");
  page.dataset.pptxPage = (index + 1).toString();
  page.style.width = `${PPTX_PAGE_WIDTH.toString()}px`;
  page.style.height = `${PPTX_PAGE_HEIGHT.toString()}px`;
  page.style.position = "relative";
  page.style.overflow = "hidden";
  page.style.background = "#ffffff";

  const scale = Math.min(
    PPTX_PAGE_WIDTH / presentation.width,
    PPTX_PAGE_HEIGHT / presentation.height,
  );
  const offsetX = (PPTX_PAGE_WIDTH - presentation.width * scale) / 2;
  const offsetY = (PPTX_PAGE_HEIGHT - presentation.height * scale) / 2;
  handle.element.style.transform = `translate(${offsetX.toString()}px, ${offsetY.toString()}px) scale(${scale.toString()})`;
  handle.element.style.transformOrigin = "top left";
  page.append(handle.element);
  return page;
}

function validatePresentation(presentation: PresentationData): void {
  if (
    !Number.isFinite(presentation.width) ||
    presentation.width <= 0 ||
    !Number.isFinite(presentation.height) ||
    presentation.height <= 0 ||
    presentation.slides.length === 0
  ) {
    throw new PptxRenderError(
      "invalid_file",
      "The PPTX presentation has invalid dimensions or no slides",
    );
  }
  if (presentation.slides.length > PPTX_RENDER_LIMITS.maxPages) {
    throw new PptxRenderError(
      "too_many_pages",
      `PPTX has ${presentation.slides.length.toString()} pages; the limit is ${PPTX_RENDER_LIMITS.maxPages.toString()}`,
    );
  }
}

function normalizePageError(
  error: unknown,
  pageIndex: number,
): PptxRenderError {
  if (error instanceof PptxRenderError) {
    return error;
  }
  return new PptxRenderError(
    "render_failed",
    `Page ${(pageIndex + 1).toString()} could not be rendered in the browser`,
    { cause: error, pageIndex },
  );
}

async function exportPages(
  pages: readonly PptxRenderedPage[],
  ensureActive: () => void,
  signal: AbortSignal,
  activeCaptures: Set<Promise<Blob>>,
): Promise<readonly Blob[]> {
  const output: (Blob | undefined)[] = Array.from(
    { length: pages.length },
    () => {
      return undefined;
    },
  );
  let nextIndex = 0;
  let firstFailure: { readonly error: unknown } | undefined;

  const exportPage = async (
    page: PptxRenderedPage,
    index: number,
  ): Promise<Blob> => {
    signal.throwIfAborted();
    ensureActive();
    await waitForExportResources(page.element, index, signal);
    ensureActive();
    const rawCapture = domToBlob(page.element, {
      backgroundColor: "#ffffff",
      height: PPTX_PAGE_HEIGHT,
      scale: 1,
      timeout: PPTX_RENDER_LIMITS.resourceTimeoutMs,
      type: "image/png",
      width: PPTX_PAGE_WIDTH,
    });
    const trackedCapture = withCleanup(rawCapture, () => {
      activeCaptures.delete(trackedCapture);
    });
    activeCaptures.add(trackedCapture);
    const blob = await waitWithDeadline(
      () => {
        return trackedCapture;
      },
      signal,
      new PptxRenderError(
        "resource_timeout",
        `Page ${(index + 1).toString()} PNG export timed out`,
        { pageIndex: index },
      ),
    );
    ensureActive();
    if (blob.size === 0 || blob.type !== "image/png") {
      throw new PptxRenderError(
        "export_failed",
        `Page ${(index + 1).toString()} did not produce a valid PNG blob`,
        { pageIndex: index },
      );
    }
    return blob;
  };

  const worker = async () => {
    while (firstFailure === undefined && nextIndex < pages.length) {
      const index = nextIndex;
      nextIndex += 1;
      const page = pages[index];
      const [result] = await Promise.allSettled([exportPage(page, index)]);
      if (result.status === "rejected") {
        firstFailure ??= { error: result.reason };
      } else {
        output[index] = result.value;
      }
    }
  };

  const workers = Array.from(
    {
      length: Math.min(PPTX_RENDER_LIMITS.pageExportConcurrency, pages.length),
    },
    worker,
  );
  const workerResults = await Promise.allSettled(workers);
  if (firstFailure !== undefined) {
    throw firstFailure.error;
  }
  const rejectedWorker = workerResults.find((result) => {
    return result.status === "rejected";
  });
  if (rejectedWorker?.status === "rejected") {
    throw rejectedWorker.reason;
  }
  return output.map((blob, index) => {
    if (blob === undefined) {
      throw new PptxRenderError(
        "export_failed",
        `Page ${(index + 1).toString()} PNG export did not complete`,
        { pageIndex: index },
      );
    }
    return blob;
  });
}

async function waitForExportResources(
  page: HTMLElement,
  pageIndex: number,
  signal: AbortSignal,
): Promise<void> {
  const resourcesResult = await settle(
    waitWithDeadline(
      async (deadlineSignal) => {
        await Promise.all([
          waitForAbortablePromise(document.fonts.ready, deadlineSignal),
          waitForPageImages(page, deadlineSignal),
        ]);
      },
      signal,
      new PptxRenderError(
        "resource_timeout",
        `Page ${(pageIndex + 1).toString()} resources were not ready for PNG export`,
        { pageIndex },
      ),
    ),
    signal,
  );
  if (!resourcesResult.ok) {
    if (resourcesResult.error instanceof PptxRenderError) {
      throw resourcesResult.error;
    }
    throw new PptxRenderError(
      "export_failed",
      `Page ${(pageIndex + 1).toString()} has image resources that could not be exported`,
      {
        cause: resourcesResult.error,
        pageIndex,
      },
    );
  }
}

function normalizeExportError(error: unknown): PptxRenderError {
  if (error instanceof PptxRenderError) {
    return error;
  }
  return new PptxRenderError(
    "export_failed",
    "The PPTX pages could not be exported as PNG files",
    { cause: error },
  );
}

async function buildValidatedPresentation(
  files: PptxFiles,
): Promise<PresentationData> {
  await Promise.resolve();
  const presentation = buildPresentation(files, { lazySlides: true });
  validatePresentation(presentation);
  return presentation;
}

async function releaseExportAfterCaptures(
  captures: readonly Promise<Blob>[],
  release: () => void,
): Promise<void> {
  await Promise.allSettled(captures);
  release();
}

function releaseExportOwnership(
  activeCaptures: ReadonlySet<Promise<Blob>>,
  release: () => void,
): void {
  if (activeCaptures.size === 0) {
    release();
    return;
  }
  detach(
    releaseExportAfterCaptures([...activeCaptures], release),
    Reason.Daemon,
    "PPTX PNG export ownership",
  );
}

async function createRenderSession(
  presentation: PresentationData,
  target: HTMLElement,
  signal: AbortSignal,
): Promise<PptxRenderSession> {
  const root = document.createElement("div");
  root.dataset.pptxRenderer = "browser";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  target.append(root);

  const handles: SlideHandle[] = [];
  const pages: PptxRenderedPage[] = [];
  const mediaUrlCache = new Map<string, string>();
  let resourcesDisposed = false;
  let removeAbortListener = () => {};
  const disposeResources = () => {
    if (resourcesDisposed) {
      return;
    }
    resourcesDisposed = true;
    removeAbortListener();
    for (const handle of handles) {
      handle.dispose();
    }
    for (const url of mediaUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    mediaUrlCache.clear();
    root.remove();
  };
  const onAbort = () => {
    disposeResources();
  };
  removeAbortListener = () => {
    signal.removeEventListener("abort", onAbort);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const renderAllPages = async () => {
    for (let index = 0; index < presentation.slides.length; index += 1) {
      signal.throwIfAborted();
      const nodeErrors: unknown[] = [];
      const chartInstances: PptxChartInstances = new Set();
      const handle = renderSlide(presentation, presentation.slides[index], {
        chartInstances,
        mediaUrlCache,
        onNodeError(nodeId, error) {
          nodeErrors.push(
            new Error(`PPTX node ${nodeId} could not be rendered`, {
              cause: error,
            }),
          );
        },
        pdfjs: false,
      });
      handles.push(handle);
      const element = createPageSurface(presentation, handle, index);
      root.append(element);
      await waitForPageResources(
        element,
        handle,
        chartInstances,
        index,
        signal,
      );
      if (nodeErrors.length > 0) {
        throw new AggregateError(nodeErrors, "One or more PPTX nodes failed");
      }
      pages.push({ element, index });
    }
  };
  const renderResult = await settle(
    onRejection(renderAllPages(), disposeResources),
    signal,
  );
  if (!renderResult.ok) {
    throw normalizePageError(renderResult.error, pages.length);
  }

  let exportInProgress = false;
  const ensureActive = () => {
    if (resourcesDisposed) {
      throw new PptxRenderError(
        "disposed",
        "This PPTX render session has been disposed",
      );
    }
  };
  return {
    pageCount: pages.length,
    pages,
    async exportPngs(exportSignal: AbortSignal) {
      const combinedSignal = AbortSignal.any([signal, exportSignal]);
      combinedSignal.throwIfAborted();
      ensureActive();
      if (exportInProgress) {
        throw new PptxRenderError(
          "concurrency_limit",
          "Only one PNG export operation may run per PPTX render session",
        );
      }
      exportInProgress = true;
      const activeCaptures = new Set<Promise<Blob>>();
      const exportResult = await settle(
        withCleanup(
          exportPages(pages, ensureActive, combinedSignal, activeCaptures),
          () => {
            releaseExportOwnership(activeCaptures, () => {
              exportInProgress = false;
            });
          },
        ),
        combinedSignal,
      );
      if (!exportResult.ok) {
        throw normalizeExportError(exportResult.error);
      }
      return exportResult.value;
    },
    dispose() {
      if (!resourcesDisposed) {
        exportInProgress = false;
        disposeResources();
      }
    },
  };
}

export async function renderPptx(
  request: RenderPptxRequest,
  signal: AbortSignal,
): Promise<PptxRenderSession> {
  signal.throwIfAborted();
  if (!request.target.isConnected) {
    throw new PptxRenderError(
      "invalid_target",
      "The PPTX render target must be connected to the document",
    );
  }

  const buffer = await readSource(request.source);
  signal.throwIfAborted();

  const filesResult = await settle(
    parseZipLazyMedia(buffer, {
      maxConcurrency: PPTX_RENDER_LIMITS.zipConcurrency,
      maxEntries: PPTX_RENDER_LIMITS.maxZipEntries,
      maxEntryUncompressedBytes: PPTX_RENDER_LIMITS.maxEntryUncompressedBytes,
      maxMediaBytes: PPTX_RENDER_LIMITS.maxMediaBytes,
      maxTotalUncompressedBytes: PPTX_RENDER_LIMITS.maxTotalUncompressedBytes,
    }),
  );
  if (!filesResult.ok) {
    throw mapParseError(filesResult.error);
  }
  signal.throwIfAborted();
  const files = filesResult.value;
  assertSupportedContent(files);

  const presentationResult = await settle(buildValidatedPresentation(files));
  if (!presentationResult.ok) {
    throw mapParseError(presentationResult.error);
  }
  signal.throwIfAborted();
  const presentation = presentationResult.value;
  return createRenderSession(presentation, request.target, signal);
}
