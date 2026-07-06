import { state } from "ccstate";
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

function rectWithTop(top: number, height = 0): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => {
      return {};
    },
  } as DOMRect;
}

function setViewportTop(element: HTMLElement, top: number): void {
  element.getBoundingClientRect = () => {
    return rectWithTop(top);
  };
}

function appendUserAnchor(
  scrollContainer: HTMLElement,
  contentTop: number,
  height = 0,
): HTMLElement {
  const anchor = document.createElement("article");
  anchor.dataset.role = "user";
  scrollContainer.firstElementChild?.appendChild(anchor);
  setViewportTop(scrollContainer, 0);
  anchor.getBoundingClientRect = () => {
    return rectWithTop(contentTop - scrollContainer.scrollTop, height);
  };
  return anchor;
}

function mockResizeObserver(): { restore: () => void; triggerAll: () => void } {
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

  function installResizeObserver(): { triggerAll: () => void } {
    const resizeObserver = mockResizeObserver();
    resizeObserverCleanups.push(resizeObserver.restore);
    return {
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

  it("uses the bottom target when latest user message anchoring is disabled", () => {
    const anchorEnabled$ = state(false);
    const scroll = createScrollSignals("anchor-disabled", {
      scrollToBottomAnchor: {
        selector: '[data-role="user"]',
        enabled$: anchorEnabled$,
      },
    });
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    appendUserAnchor(scrollContainer, 500);

    bindScrollContainer(scroll, scrollContainer);
    ctx.store.set(scroll.scrollToBottom$);

    expect(scrollContainer.scrollTop).toBe(1000);
  });

  it("stays at the bottom while the latest user message cannot reach the top", () => {
    const anchorEnabled$ = state(true);
    const scroll = createScrollSignals("anchor-before-enough-content", {
      scrollToBottomAnchor: {
        selector: '[data-role="user"]',
        enabled$: anchorEnabled$,
      },
    });
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    appendUserAnchor(scrollContainer, 900);

    bindScrollContainer(scroll, scrollContainer);
    ctx.store.set(scroll.scrollToBottom$);

    expect(scrollContainer.scrollTop).toBe(700);
  });

  it("continues to the latest user message top once enough content renders", () => {
    const resizeObserver = installResizeObserver();
    const anchorEnabled$ = state(true);
    const scroll = createScrollSignals("anchor-after-content-growth", {
      scrollToBottomAnchor: {
        selector: '[data-role="user"]',
        enabled$: anchorEnabled$,
      },
    });
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    appendUserAnchor(scrollContainer, 900);

    bindScrollContainer(scroll, scrollContainer);
    ctx.store.set(scroll.scrollToBottom$);
    expect(scrollContainer.scrollTop).toBe(700);

    setScrollMetrics(scrollContainer, {
      scrollHeight: 1500,
      clientHeight: 300,
    });
    resizeObserver.triggerAll();

    expect(scrollContainer.scrollTop).toBe(900);
  });

  it("uses the bottom target when the latest user message does not fit in the viewport", () => {
    const anchorEnabled$ = state(true);
    const scroll = createScrollSignals("anchor-taller-than-viewport", {
      scrollToBottomAnchor: {
        selector: '[data-role="user"]',
        enabled$: anchorEnabled$,
      },
    });
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1800,
      clientHeight: 300,
    });
    appendUserAnchor(scrollContainer, 900, 360);

    bindScrollContainer(scroll, scrollContainer);
    ctx.store.set(scroll.scrollToBottom$);

    expect(scrollContainer.scrollTop).toBe(1800);
  });

  it("does not restore the latest user message anchor after user scrolling", () => {
    const resizeObserver = installResizeObserver();
    const anchorEnabled$ = state(true);
    const scroll = createScrollSignals("anchor-user-scroll-cancel", {
      scrollToBottomAnchor: {
        selector: '[data-role="user"]',
        enabled$: anchorEnabled$,
      },
    });
    const scrollContainer = createScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1500,
      clientHeight: 300,
    });
    appendUserAnchor(scrollContainer, 900);

    bindScrollContainer(scroll, scrollContainer);
    ctx.store.set(scroll.scrollToBottom$);
    scrollContainer.dispatchEvent(new Event("scroll"));
    expect(scrollContainer.scrollTop).toBe(900);

    scrollContainer.dispatchEvent(new Event("wheel"));
    scrollContainer.scrollTop = 1000;
    scrollContainer.dispatchEvent(new Event("scroll"));
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1800,
      clientHeight: 300,
    });
    resizeObserver.triggerAll();

    expect(scrollContainer.scrollTop).toBe(1800);
  });
});
