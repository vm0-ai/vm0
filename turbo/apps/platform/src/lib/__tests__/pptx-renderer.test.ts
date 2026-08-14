import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import supportedFixture from "./fixtures/pptx/supported.pptx?inline";
import tooManyPagesFixture from "./fixtures/pptx/too-many-pages.pptx?inline";
import unsupportedOleFixture from "./fixtures/pptx/unsupported-ole.pptx?inline";
import {
  PPTX_PAGE_HEIGHT,
  PPTX_PAGE_WIDTH,
  PPTX_RENDER_LIMITS,
  renderPptx,
  type PptxRenderSession,
} from "../pptx-renderer.ts";
import { createDeferredPromise } from "../../signals/utils.ts";

const screenshotState = vi.hoisted(() => {
  return {
    active: 0,
    blockedPages: [] as string[],
    blockPromise: undefined as Promise<void> | undefined,
    capturedPages: [] as string[],
    failedPages: [] as string[],
    failPage: undefined as string | undefined,
    maxActive: 0,
    pageTwoStarted: undefined as Promise<void> | undefined,
    resolvePageTwoStarted: undefined as (() => void) | undefined,
  };
});

const imageState = vi.hoisted(() => {
  return {
    decodeError: undefined as Error | undefined,
    decodePromise: undefined as Promise<void> | undefined,
    decodedSources: [] as string[],
  };
});

vi.mock("modern-screenshot", () => {
  return {
    async domToBlob(element: HTMLElement) {
      screenshotState.active += 1;
      screenshotState.maxActive = Math.max(
        screenshotState.maxActive,
        screenshotState.active,
      );
      const pageNumber = element.dataset.pptxPage ?? "missing";
      screenshotState.capturedPages.push(pageNumber);
      if (pageNumber === "2") {
        screenshotState.resolvePageTwoStarted?.();
      }
      try {
        await Promise.resolve();
        if (pageNumber === screenshotState.failPage) {
          screenshotState.failedPages.push(pageNumber);
          throw new Error(`Page ${pageNumber} screenshot failed`);
        }
        if (
          screenshotState.blockedPages.includes(pageNumber) &&
          screenshotState.blockPromise !== undefined
        ) {
          await screenshotState.blockPromise;
        }
        if (pageNumber === "1") {
          await screenshotState.pageTwoStarted;
        }
        return new Blob([pageNumber], { type: "image/png" });
      } finally {
        screenshotState.active -= 1;
      }
    },
  };
});

const fixtures = Object.freeze({
  supported: supportedFixture,
  tooManyPages: tooManyPagesFixture,
  unsupportedOle: unsupportedOleFixture,
});

function activeSignal(): AbortSignal {
  return AbortSignal.any([]);
}

function fixtureData(dataUrl: string): ArrayBuffer {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => {
    return character.charCodeAt(0);
  }).buffer;
}

function connectedTarget(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  return target;
}

function renderSupported(target: HTMLElement): Promise<PptxRenderSession> {
  return renderPptx(
    {
      source: {
        data: fixtureData(fixtures.supported),
        filename: "supported.pptx",
      },
      target,
    },
    activeSignal(),
  );
}

beforeAll(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  Object.defineProperty(Element.prototype, "lookupNamespaceURI", {
    configurable: true,
    value(this: Element, prefix: string | null): string | null {
      const attribute = prefix === null ? "xmlns" : `xmlns:${prefix}`;
      function findNamespace(element: Element | null): string | null {
        if (element === null) {
          return null;
        }
        const namespace = element.getAttribute(attribute);
        if (namespace !== null) {
          return namespace;
        }
        return findNamespace(element.parentElement);
      }
      return findNamespace(this);
    },
  });
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value(this: HTMLImageElement): Promise<void> {
      imageState.decodedSources.push(this.currentSrc || this.src);
      if (imageState.decodeError !== undefined) {
        return Promise.reject(imageState.decodeError);
      }
      return imageState.decodePromise ?? Promise.resolve();
    },
  });
});

beforeEach(() => {
  screenshotState.active = 0;
  screenshotState.blockedPages = [];
  screenshotState.blockPromise = undefined;
  screenshotState.capturedPages = [];
  screenshotState.failedPages = [];
  screenshotState.failPage = undefined;
  screenshotState.maxActive = 0;
  screenshotState.pageTwoStarted = undefined;
  screenshotState.resolvePageTwoStarted = undefined;
  imageState.decodeError = undefined;
  imageState.decodePromise = undefined;
  imageState.decodedSources = [];
});

describe("renderPptx", () => {
  it("renders real CJK, image, shape, table, and chart content into fixed pages", async () => {
    const target = connectedTarget();
    const session = await renderSupported(target);

    expect(session.pageCount).toBe(3);
    expect(
      session.pages.map(({ index }) => {
        return index;
      }),
    ).toStrictEqual([0, 1, 2]);
    for (const page of session.pages) {
      expect(page.element.style.width).toBe(`${PPTX_PAGE_WIDTH.toString()}px`);
      expect(page.element.style.height).toBe(
        `${PPTX_PAGE_HEIGHT.toString()}px`,
      );
      expect(page.element.isConnected).toBeTruthy();
    }
    expect(session.pages[0].element.textContent).toContain(
      "中文字体与混排：浏览器原生渲染一致",
    );
    expect(
      session.pages[0].element.querySelectorAll("svg").length,
    ).toBeGreaterThan(0);
    expect(session.pages[1].element.querySelector("img")).not.toBeNull();
    expect(session.pages[1].element.querySelector("table")).not.toBeNull();
    expect(session.pages[1].element.textContent).toContain("Merged header");
    // happy-dom has no CanvasRenderingContext2D, but the real renderer still
    // parses the chart and builds its chart tree and legend at this boundary.
    expect(
      session.pages[2].element.querySelector(".pptx-chart-custom-legend"),
    ).not.toBeNull();
    expect(session.pages[2].element.textContent).toContain("预览");
    expect(session.pages[2].element.textContent).toContain("PNG");

    session.dispose();
    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it("exports ordered PNG blobs from the same rendered page elements", async () => {
    const pageTwoStarted = createDeferredPromise<void>(activeSignal());
    screenshotState.pageTwoStarted = pageTwoStarted.promise;
    screenshotState.resolvePageTwoStarted = () => {
      pageTwoStarted.resolve(undefined);
    };
    const target = connectedTarget();
    const session = await renderSupported(target);

    const pngs = await session.exportPngs(activeSignal());

    await expect(
      Promise.all(
        pngs.map((blob) => {
          return blob.text();
        }),
      ),
    ).resolves.toStrictEqual(["1", "2", "3"]);
    expect(
      pngs.every((blob) => {
        return blob.type === "image/png";
      }),
    ).toBeTruthy();
    expect(screenshotState.maxActive).toBe(
      PPTX_RENDER_LIMITS.pageExportConcurrency,
    );

    session.dispose();
    target.remove();
  });

  it("waits for real fixture images to decode before completing preview", async () => {
    const imageGate = createDeferredPromise<void>(activeSignal());
    imageState.decodePromise = imageGate.promise;
    const target = connectedTarget();
    const renderPromise = renderSupported(target);
    let renderCompleted = false;
    const observeRender = async () => {
      await renderPromise;
      renderCompleted = true;
    };
    const observation = observeRender();

    await vi.waitFor(() => {
      expect(imageState.decodedSources.length).toBeGreaterThan(0);
    });
    expect(renderCompleted).toBeFalsy();

    imageGate.resolve(undefined);
    const session = await renderPromise;
    await observation;
    expect(renderCompleted).toBeTruthy();

    session.dispose();
    target.remove();
  });

  it("turns a real fixture image decode failure into a render error", async () => {
    imageState.decodeError = new Error("image decode failed");
    const target = connectedTarget();

    await expect(renderSupported(target)).rejects.toMatchObject({
      code: "render_failed",
    });
    expect(imageState.decodedSources.length).toBeGreaterThan(0);
    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it("limits a render session to one active PNG export operation", async () => {
    const target = connectedTarget();
    const session = await renderSupported(target);

    const firstExport = session.exportPngs(activeSignal());
    await expect(session.exportPngs(activeSignal())).rejects.toMatchObject({
      code: "concurrency_limit",
    });
    await firstExport;

    session.dispose();
    target.remove();
  });

  it("stops assigning pages after a failure and retains sibling ownership", async () => {
    const blockedCapture = createDeferredPromise<void>(activeSignal());
    screenshotState.failPage = "1";
    screenshotState.blockedPages = ["2"];
    screenshotState.blockPromise = blockedCapture.promise;
    const target = connectedTarget();
    const session = await renderSupported(target);
    const firstExport = Promise.allSettled([
      session.exportPngs(activeSignal()),
    ]);

    await vi.waitFor(() => {
      expect(screenshotState.failedPages).toStrictEqual(["1"]);
      expect(screenshotState.capturedPages).toContain("2");
    });
    await expect(session.exportPngs(activeSignal())).rejects.toMatchObject({
      code: "concurrency_limit",
    });
    expect(screenshotState.capturedPages).not.toContain("3");

    blockedCapture.resolve(undefined);
    const [result] = await firstExport;
    expect(result).toMatchObject({
      reason: { code: "export_failed" },
      status: "rejected",
    });
    expect(screenshotState.maxActive).toBeLessThanOrEqual(
      PPTX_RENDER_LIMITS.pageExportConcurrency,
    );

    session.dispose();
    target.remove();
  });

  it("retains the export lock until timed-out raw captures settle", async () => {
    const blockedCapture = createDeferredPromise<void>(activeSignal());
    screenshotState.blockedPages = ["1", "2"];
    screenshotState.blockPromise = blockedCapture.promise;
    const target = connectedTarget();
    const session = await renderSupported(target);
    const exportSignal = AbortSignal.timeout(500);
    const firstExport = Promise.allSettled([session.exportPngs(exportSignal)]);

    await vi.waitFor(() => {
      expect(screenshotState.capturedPages).toContain("1");
      expect(screenshotState.capturedPages).toContain("2");
    });
    const [result] = await firstExport;
    expect(result).toMatchObject({
      reason: { name: "TimeoutError" },
      status: "rejected",
    });
    await expect(session.exportPngs(activeSignal())).rejects.toMatchObject({
      code: "concurrency_limit",
    });

    blockedCapture.resolve(undefined);
    await vi.waitFor(() => {
      expect(screenshotState.active).toBe(0);
    });
    await Promise.resolve();
    await Promise.resolve();
    screenshotState.blockedPages = [];
    screenshotState.blockPromise = undefined;
    await expect(session.exportPngs(activeSignal())).resolves.toHaveLength(3);

    session.dispose();
    target.remove();
  });

  it("fails an active export when its render session is disposed", async () => {
    const target = connectedTarget();
    const session = await renderSupported(target);

    const exportPromise = session.exportPngs(activeSignal());
    session.dispose();

    await expect(exportPromise).rejects.toMatchObject({ code: "disposed" });
    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it("rejects unsupported OLE content before mounting a preview", async () => {
    const target = connectedTarget();
    await expect(
      renderPptx(
        {
          source: {
            data: fixtureData(fixtures.unsupportedOle),
            filename: "unsupported-ole.pptx",
          },
          target,
        },
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "unsupported_content", feature: "ole" });

    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it("rejects a real PPTX above the page limit", async () => {
    const target = connectedTarget();
    await expect(
      renderPptx(
        {
          source: {
            data: fixtureData(fixtures.tooManyPages),
            filename: "too-many-pages.pptx",
          },
          target,
        },
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "too_many_pages" });
    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it.each(["legacy.ppt", "document.pdf", "slides.html"])(
    "rejects unsupported source extension %s",
    async (filename) => {
      const target = connectedTarget();
      await expect(
        renderPptx(
          {
            source: {
              data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
              filename,
            },
            target,
          },
          activeSignal(),
        ),
      ).rejects.toMatchObject({ code: "unsupported_format" });
      target.remove();
    },
  );

  it("distinguishes invalid and encrypted PPTX containers", async () => {
    const target = connectedTarget();
    await expect(
      renderPptx(
        {
          source: {
            data: new TextEncoder().encode("%PDF-1.7").buffer,
            filename: "renamed.pptx",
          },
          target,
        },
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_file" });
    await expect(
      renderPptx(
        {
          source: {
            data: new Uint8Array([
              0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
            ]).buffer,
            filename: "encrypted.pptx",
          },
          target,
        },
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "encrypted_file" });
    target.remove();
  });

  it("rejects oversized sources before reading them", async () => {
    class OversizedBlob extends Blob {
      override get size(): number {
        return PPTX_RENDER_LIMITS.maxSourceBytes + 1;
      }
    }

    const target = connectedTarget();
    await expect(
      renderPptx(
        {
          source: { data: new OversizedBlob(), filename: "oversized.pptx" },
          target,
        },
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    target.remove();
  });

  it("requires a connected browser target and makes disposal explicit", async () => {
    const detachedTarget = document.createElement("div");
    await expect(
      renderPptx(
        {
          source: {
            data: fixtureData(fixtures.supported),
            filename: "supported.pptx",
          },
          target: detachedTarget,
        },
        activeSignal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });

    const target = connectedTarget();
    const session = await renderSupported(target);
    session.dispose();
    session.dispose();
    await expect(session.exportPngs(activeSignal())).rejects.toMatchObject({
      code: "disposed",
    });
    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it("honors an already-aborted parent lifecycle before mounting", async () => {
    const target = connectedTarget();

    await expect(
      renderPptx(
        {
          source: {
            data: fixtureData(fixtures.supported),
            filename: "supported.pptx",
          },
          target,
        },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(target.childElementCount).toBe(0);
    target.remove();
  });
});
