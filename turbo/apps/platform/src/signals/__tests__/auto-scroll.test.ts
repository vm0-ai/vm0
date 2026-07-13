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
  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => {
      return scrollTop;
    },
    set: (value: number) => {
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );
      scrollTop = Math.max(0, Math.min(value, maxScrollTop));
    },
  });
  container.appendChild(content);
  document.body.appendChild(container);
  return container;
}

function mockResizeObserver(): {
  restore: () => void;
  trigger: (target: Element) => void;
  triggerAll: () => void;
} {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver",
  );
  const observers: TestResizeObserver[] = [];

  class TestResizeObserver implements ResizeObserver {
    private observedTargets = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }

    observe(target: Element): void {
      this.observedTargets.add(target);
    }

    unobserve(target: Element): void {
      this.observedTargets.delete(target);
    }

    disconnect(): void {
      this.observedTargets = new Set<Element>();
    }

    trigger(target?: Element): void {
      const targets = target
        ? this.observedTargets.has(target)
          ? [target]
          : []
        : [...this.observedTargets];
      if (targets.length === 0) {
        return;
      }
      this.callback(
        targets.map((observedTarget) => {
          return {
            target: observedTarget,
            contentRect: observedTarget.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry;
        }),
        this,
      );
    }
  }

  let restored = false;
  const restore = () => {
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
    restore,
    trigger: (target) => {
      for (const observer of observers) {
        observer.trigger(target);
      }
    },
    triggerAll: () => {
      for (const observer of observers) {
        observer.trigger();
      }
    },
  };
}

describe("auto-scroll", () => {
  const ctx = testContext();
  const resizeObserverCleanups: (() => void)[] = [];
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

  function installResizeObserver(): {
    trigger: (target: Element) => void;
    triggerAll: () => void;
  } {
    const resizeObserver = mockResizeObserver();
    resizeObserverCleanups.push(resizeObserver.restore);
    return {
      trigger: resizeObserver.trigger,
      triggerAll: resizeObserver.triggerAll,
    };
  }

  afterEach(() => {
    for (const cleanup of scrollRefCleanups.splice(0).reverse()) {
      cleanup();
    }
    for (const cleanup of resizeObserverCleanups.splice(0).reverse()) {
      cleanup();
    }
    document.body.textContent = "";
  });

  it("keeps the viewport anchored when prepended content increases height", () => {
    const resizeObserver = installResizeObserver();
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
    const resizeObserver = installResizeObserver();
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
    const resizeObserver = installResizeObserver();
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

  it("keeps a mobile chat at the bottom when its viewport becomes shorter", () => {
    const resizeObserver = installResizeObserver();
    ctx.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)";
    });
    const scroll = createScrollSignals("mobile-viewport-resize", {
      observeViewportResizeOnMobile: true,
    });
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 700;

    bindScrollContainer(scroll, scrollContainer);
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 180,
    });
    resizeObserver.trigger(scrollContainer);

    expect(scrollContainer.scrollTop).toBe(820);
  });

  it("preserves a mobile history-reading position when the viewport becomes shorter", () => {
    const resizeObserver = installResizeObserver();
    ctx.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)";
    });
    const scroll = createScrollSignals("mobile-history-resize", {
      observeViewportResizeOnMobile: true,
    });
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 700;

    bindScrollContainer(scroll, scrollContainer);
    scrollContainer.dispatchEvent(new Event("pointerdown"));
    scrollContainer.scrollTop = 400;
    scrollContainer.dispatchEvent(new Event("scroll"));
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 180,
    });
    resizeObserver.trigger(scrollContainer);

    expect(scrollContainer.scrollTop).toBe(400);
  });

  it("does not observe the chat viewport resize on desktop", () => {
    const resizeObserver = installResizeObserver();
    ctx.mocks.browser.matchMedia(false);
    const scroll = createScrollSignals("desktop-viewport-resize", {
      observeViewportResizeOnMobile: true,
    });
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 700;

    bindScrollContainer(scroll, scrollContainer);
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 180,
    });
    resizeObserver.trigger(scrollContainer);

    expect(scrollContainer.scrollTop).toBe(700);
  });
});
