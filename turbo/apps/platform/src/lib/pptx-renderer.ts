import {
  buildPresentation,
  parseZipLazyMedia,
  renderSlide,
  type PptxFiles,
  type PresentationData,
  type SlideHandle,
} from "@aiden0z/pptx-renderer";
import { domToBlob, waitUntilLoad } from "modern-screenshot";
import { animationFrame } from "signal-timers";

import {
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
  | "equation"
  | "macro"
  | "ole"
  | "vector-metafile";

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
    feature: "vector-metafile",
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

async function forwardPromise<T>(
  promise: Promise<T>,
  deferred: ReturnType<typeof createDeferredPromise<T>>,
): Promise<void> {
  const [result] = await Promise.allSettled([promise]);
  if (!deferred.settled()) {
    if (result.status === "fulfilled") {
      deferred.resolve(result.value);
    } else {
      deferred.reject(result.reason);
    }
  }
}

function waitWithDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutError: PptxRenderError,
): Promise<T> {
  const deferred = createDeferredPromise<T>(signal);
  const timeoutId = window.setTimeout(() => {
    if (!deferred.settled()) {
      deferred.reject(timeoutError);
    }
  }, PPTX_RENDER_LIMITS.resourceTimeoutMs);
  detach(
    forwardPromise(promise, deferred),
    Reason.Daemon,
    "PPTX resource deadline",
  );
  return withCleanup(deferred.promise, () => {
    window.clearTimeout(timeoutId);
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

async function waitForPageResources(
  page: HTMLElement,
  handle: SlideHandle,
  pageIndex: number,
  signal: AbortSignal,
): Promise<void> {
  const mediaErrors: Error[] = [];
  const resourcesReady = async () => {
    await Promise.all([
      handle.ready,
      document.fonts.ready,
      waitUntilLoad(page, {
        timeout: PPTX_RENDER_LIMITS.resourceTimeoutMs,
        onError(error) {
          mediaErrors.push(error);
        },
      }),
    ]);
    if (mediaErrors.length > 0) {
      throw new AggregateError(
        mediaErrors,
        "One or more page images failed to load",
      );
    }
    await nextPaint(signal);
    await nextPaint(signal);
  };

  await waitWithDeadline(
    resourcesReady(),
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
): Promise<readonly Blob[]> {
  const output: (Blob | undefined)[] = Array.from(
    { length: pages.length },
    () => {
      return undefined;
    },
  );
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < pages.length) {
      const index = nextIndex;
      nextIndex += 1;
      const page = pages[index];
      signal.throwIfAborted();
      ensureActive();
      await waitForExportResources(page.element, index, signal);
      ensureActive();
      const blob = await waitWithDeadline(
        domToBlob(page.element, {
          backgroundColor: "#ffffff",
          height: PPTX_PAGE_HEIGHT,
          scale: 1,
          timeout: PPTX_RENDER_LIMITS.resourceTimeoutMs,
          type: "image/png",
          width: PPTX_PAGE_WIDTH,
        }),
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
      output[index] = blob;
    }
  };

  const workers = Array.from(
    {
      length: Math.min(PPTX_RENDER_LIMITS.pageExportConcurrency, pages.length),
    },
    worker,
  );
  await Promise.all(workers);
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
  const mediaErrors: Error[] = [];
  await waitWithDeadline(
    Promise.all([
      document.fonts.ready,
      waitUntilLoad(page, {
        timeout: PPTX_RENDER_LIMITS.resourceTimeoutMs,
        onError(error) {
          mediaErrors.push(error);
        },
      }),
    ]),
    signal,
    new PptxRenderError(
      "resource_timeout",
      `Page ${(pageIndex + 1).toString()} resources were not ready for PNG export`,
      { pageIndex },
    ),
  );
  if (mediaErrors.length > 0) {
    throw new PptxRenderError(
      "export_failed",
      `Page ${(pageIndex + 1).toString()} has image resources that could not be exported`,
      {
        cause: new AggregateError(
          mediaErrors,
          "One or more page images failed to export",
        ),
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
      const handle = renderSlide(presentation, presentation.slides[index], {
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
      await waitForPageResources(element, handle, index, signal);
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
      const exportResult = await settle(
        withCleanup(exportPages(pages, ensureActive, combinedSignal), () => {
          exportInProgress = false;
        }),
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
