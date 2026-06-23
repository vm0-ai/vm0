import { afterEach, describe, expect, it } from "vitest";

import { createScrollSignals } from "../auto-scroll.ts";
import { testContext } from "./test-helpers.ts";

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
  });
}

function createScrollContainer(): HTMLElement {
  const container = document.createElement("section");
  const content = document.createElement("div");
  container.appendChild(content);
  document.body.appendChild(container);
  return container;
}

let restoreResizeObserver = () => {};

function mockResizeObserver(): { triggerAll: () => void } {
  restoreResizeObserver();
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver",
  );
  const observers: TestResizeObserver[] = [];

  class TestResizeObserver implements ResizeObserver {
    private observedTarget: Element | null = null;

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }

    observe(target: Element): void {
      this.observedTarget = target;
    }

    unobserve(target: Element): void {
      if (this.observedTarget === target) {
        this.observedTarget = null;
      }
    }

    disconnect(): void {
      this.observedTarget = null;
    }

    trigger(): void {
      if (!this.observedTarget) {
        return;
      }
      this.callback(
        [
          {
            target: this.observedTarget,
            contentRect: this.observedTarget.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry,
        ],
        this,
      );
    }
  }

  let restored = false;
  restoreResizeObserver = () => {
    if (restored) {
      return;
    }
    restored = true;
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  };

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });

  return {
    triggerAll: () => {
      for (const observer of observers) {
        observer.trigger();
      }
    },
  };
}

describe("auto-scroll prepend compensation", () => {
  const ctx = testContext();
  const scrollRefCleanups: (() => void)[] = [];

  function bindScrollContainer(
    scroll: ReturnType<typeof createScrollSignals>,
    scrollContainer: HTMLElement,
  ): void {
    const cleanup = ctx.store.set(scroll.setScrollContainer$, scrollContainer);
    if (typeof cleanup === "function") {
      scrollRefCleanups.push(cleanup);
    }
  }

  afterEach(() => {
    for (const cleanup of scrollRefCleanups.splice(0).reverse()) {
      cleanup();
    }
    restoreResizeObserver();
    restoreResizeObserver = () => {};
    document.body.textContent = "";
  });

  it("keeps the viewport anchored when prepended content increases height", () => {
    const resizeObserver = mockResizeObserver();
    const scroll = createScrollSignals("prepend-compensation");
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 420;

    bindScrollContainer(scroll, scrollContainer);
    ctx.store.set(scroll.recordScrollHeightForPrepend$);
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1400,
      clientHeight: 300,
    });

    resizeObserver.triggerAll();

    expect(scrollContainer.scrollTop).toBe(820);
    expect(ctx.store.get(scroll.awayFromBottom$)).toBeTruthy();

    resizeObserver.triggerAll();
    expect(scrollContainer.scrollTop).toBe(820);
  });

  it("drops pending compensation when a prepend attempt does not change content", () => {
    const resizeObserver = mockResizeObserver();
    const scroll = createScrollSignals("prepend-noop");
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 700;

    bindScrollContainer(scroll, scrollContainer);
    scrollContainer.dispatchEvent(new Event("scroll"));
    scrollContainer.dispatchEvent(new Event("wheel"));
    scrollContainer.scrollTop = 80;
    scrollContainer.dispatchEvent(new Event("scroll"));

    const noOpToken = ctx.store.set(scroll.recordScrollHeightForPrepend$);
    ctx.store.set(scroll.clearScrollHeightForPrepend$, noOpToken);
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1400,
      clientHeight: 300,
    });

    resizeObserver.triggerAll();

    expect(scrollContainer.scrollTop).toBe(80);
    expect(ctx.store.get(scroll.awayFromBottom$)).toBeTruthy();
  });

  it("does not let a no-op prepend clear another pending compensation", () => {
    const resizeObserver = mockResizeObserver();
    const scroll = createScrollSignals("prepend-overlap");
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 80;

    bindScrollContainer(scroll, scrollContainer);
    const historyToken = ctx.store.set(scroll.recordScrollHeightForPrepend$);
    const loadMoreNoOpToken = ctx.store.set(
      scroll.recordScrollHeightForPrepend$,
    );
    expect(historyToken).not.toBe(loadMoreNoOpToken);

    ctx.store.set(scroll.clearScrollHeightForPrepend$, loadMoreNoOpToken);
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1400,
      clientHeight: 300,
    });

    resizeObserver.triggerAll();

    expect(scrollContainer.scrollTop).toBe(480);
  });
});
