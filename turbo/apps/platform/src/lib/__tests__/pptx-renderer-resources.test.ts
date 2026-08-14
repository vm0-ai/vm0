import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PPTX_RENDER_LIMITS, renderPptx } from "../pptx-renderer.ts";
import { createDeferredPromise } from "../../signals/utils.ts";

const resourceState = vi.hoisted(() => {
  return {
    captureCalls: 0,
    chartDisposed: false,
    chartFinished: true,
    chartListener: undefined as (() => void) | undefined,
    chartOffCalls: 0,
    decodeError: undefined as Error | undefined,
    decodePromise: undefined as Promise<void> | undefined,
    decodedSources: [] as string[],
  };
});

const IMAGE_SOURCES = Object.freeze([
  "https://pptx.test/background.png",
  "https://pptx.test/html.png",
  "https://pptx.test/svg.png",
]);

vi.mock("@aiden0z/pptx-renderer", () => {
  return {
    parseZipLazyMedia() {
      return Promise.resolve({
        contentTypes: "",
        presentation: "",
        presentationRels: "",
      });
    },
    buildPresentation() {
      return { height: 900, slides: [{}], width: 1600 };
    },
    renderSlide(
      _presentation: unknown,
      _slide: unknown,
      options: { chartInstances?: Set<unknown> } = {},
    ) {
      const element = document.createElement("div");
      const htmlImage = document.createElement("img");
      htmlImage.src = IMAGE_SOURCES[1];
      element.append(htmlImage);

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const svgImage = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "image",
      );
      svgImage.setAttribute("href", IMAGE_SOURCES[2]);
      svg.append(svgImage);
      element.append(svg);

      const background = document.createElement("div");
      background.style.backgroundImage = `url("${IMAGE_SOURCES[0]}")`;
      element.append(background);

      const chart = {
        getZr() {
          return {
            animation: {
              isFinished() {
                return resourceState.chartFinished;
              },
            },
          };
        },
        isDisposed() {
          return resourceState.chartDisposed;
        },
        off(eventName: string, listener: () => void) {
          resourceState.chartOffCalls += 1;
          if (
            eventName === "finished" &&
            resourceState.chartListener === listener
          ) {
            resourceState.chartListener = undefined;
          }
        },
        on(eventName: string, listener: () => void) {
          if (eventName === "finished") {
            resourceState.chartListener = listener;
          }
        },
      };
      options.chartInstances?.add(chart);

      return {
        dispose() {
          resourceState.chartDisposed = true;
        },
        element,
        ready: Promise.resolve(),
      };
    },
  };
});

vi.mock("modern-screenshot", () => {
  return {
    domToBlob() {
      resourceState.captureCalls += 1;
      return Promise.resolve(new Blob(["png"], { type: "image/png" }));
    },
  };
});

function connectedTarget(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  return target;
}

function activeSignal(): AbortSignal {
  return AbortSignal.any([]);
}

function renderResourcePage(target: HTMLElement) {
  return renderPptx(
    {
      source: {
        data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
        filename: "resources.pptx",
      },
      target,
    },
    AbortSignal.any([]),
  );
}

beforeAll(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value(this: HTMLImageElement): Promise<void> {
      resourceState.decodedSources.push(this.currentSrc || this.src);
      if (resourceState.decodeError !== undefined) {
        return Promise.reject(resourceState.decodeError);
      }
      return resourceState.decodePromise ?? Promise.resolve();
    },
  });
});

beforeEach(() => {
  resourceState.captureCalls = 0;
  resourceState.chartDisposed = false;
  resourceState.chartFinished = true;
  resourceState.chartListener = undefined;
  resourceState.chartOffCalls = 0;
  resourceState.decodeError = undefined;
  resourceState.decodePromise = undefined;
  resourceState.decodedSources = [];
});

describe("pptx resource readiness", () => {
  it("waits for HTML, SVG, CSS images and the chart finished event", async () => {
    const imageGate = createDeferredPromise<void>(activeSignal());
    resourceState.chartFinished = false;
    resourceState.decodePromise = imageGate.promise;
    const target = connectedTarget();
    const renderPromise = renderResourcePage(target);
    let renderCompleted = false;
    const observeRender = async () => {
      await renderPromise;
      renderCompleted = true;
    };
    const observation = observeRender();

    await vi.waitFor(() => {
      expect([...new Set(resourceState.decodedSources)].sort()).toStrictEqual(
        [...IMAGE_SOURCES].sort(),
      );
      expect(resourceState.chartListener).toBeTypeOf("function");
    });
    expect(renderCompleted).toBeFalsy();

    imageGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(renderCompleted).toBeFalsy();

    resourceState.chartFinished = true;
    resourceState.chartListener?.();
    const session = await renderPromise;
    await observation;
    expect(renderCompleted).toBeTruthy();
    expect(resourceState.chartListener).toBeUndefined();

    session.dispose();
    target.remove();
  });

  it("fails preview explicitly when an image cannot be decoded", async () => {
    resourceState.decodeError = new Error("decode failed");
    const target = connectedTarget();

    await expect(renderResourcePage(target)).rejects.toMatchObject({
      code: "render_failed",
      pageIndex: 0,
    });
    expect([...new Set(resourceState.decodedSources)].sort()).toStrictEqual(
      [...IMAGE_SOURCES].sort(),
    );
    expect(target.childElementCount).toBe(0);
    target.remove();
  });

  it("waits for the same image tree before export and reports decode errors", async () => {
    const target = connectedTarget();
    const session = await renderResourcePage(target);
    const imageGate = createDeferredPromise<void>(activeSignal());
    resourceState.decodedSources = [];
    resourceState.decodePromise = imageGate.promise;
    let exportCompleted = false;
    const exportPromise = session.exportPngs(AbortSignal.any([]));
    const observeExport = async () => {
      await exportPromise;
      exportCompleted = true;
    };
    const observation = observeExport();

    await vi.waitFor(() => {
      expect([...new Set(resourceState.decodedSources)].sort()).toStrictEqual(
        [...IMAGE_SOURCES].sort(),
      );
    });
    expect(resourceState.captureCalls).toBe(0);
    expect(exportCompleted).toBeFalsy();

    imageGate.resolve(undefined);
    await expect(exportPromise).resolves.toHaveLength(1);
    await observation;
    expect(resourceState.captureCalls).toBe(1);

    resourceState.decodePromise = undefined;
    resourceState.decodeError = new Error("export decode failed");
    await expect(session.exportPngs(AbortSignal.any([]))).rejects.toMatchObject(
      {
        code: "export_failed",
        pageIndex: 0,
      },
    );
    expect(resourceState.captureCalls).toBe(1);

    session.dispose();
    target.remove();
  });

  it("aborts image and chart waiters when the resource deadline expires", async () => {
    resourceState.chartFinished = false;
    const imageGate = createDeferredPromise<void>(activeSignal());
    resourceState.decodePromise = imageGate.promise;
    const nativeSetTimeout = window.setTimeout.bind(window);
    const timeoutSpy = vi
      .spyOn(window, "setTimeout")
      .mockImplementation((handler, timeout) => {
        return nativeSetTimeout(
          handler,
          timeout === PPTX_RENDER_LIMITS.resourceTimeoutMs ? 50 : timeout,
        );
      });
    const removeAttributeSpy = vi.spyOn(
      HTMLImageElement.prototype,
      "removeAttribute",
    );
    const target = connectedTarget();

    try {
      await expect(renderResourcePage(target)).rejects.toMatchObject({
        code: "resource_timeout",
        pageIndex: 0,
      });
      await vi.waitFor(() => {
        expect(resourceState.chartListener).toBeUndefined();
        expect(resourceState.chartOffCalls).toBe(1);
        expect(removeAttributeSpy).toHaveBeenCalledWith("src");
      });
      expect(resourceState.chartDisposed).toBeTruthy();
      expect(target.childElementCount).toBe(0);
    } finally {
      if (!imageGate.settled()) {
        imageGate.reject(
          new DOMException("Resource deadline test settled", "AbortError"),
        );
      }
      removeAttributeSpy.mockRestore();
      timeoutSpy.mockRestore();
      target.remove();
    }
  });
});
