import { describe, expect, it } from "vitest";
import { testContext } from "./test-helpers.ts";
import { createScrollSignals } from "../auto-scroll.ts";

const context = testContext();

// VC-SCROLL-001: ResizeObserver observes firstElementChild, not the container
describe("createScrollSignals - ResizeObserver targets inner content", () => {
  it("observes firstElementChild when it exists (VC-SCROLL-001)", () => {
    const observed: Element[] = [];
    const originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(_cb: ResizeObserverCallback) {}
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const container = document.createElement("div");
      const inner = document.createElement("div");
      container.appendChild(inner);
      document.body.appendChild(container);

      const { setScrollContainer$ } = createScrollSignals();
      context.store.set(setScrollContainer$, container);

      expect(observed).toHaveLength(1);
      expect(observed[0]).toBe(inner);
    } finally {
      globalThis.ResizeObserver = originalRO;
    }
  });

  it("falls back to container when no child exists (VC-SCROLL-002)", () => {
    const observed: Element[] = [];
    const originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(_cb: ResizeObserverCallback) {}
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const container = document.createElement("div");
      document.body.appendChild(container);

      const { setScrollContainer$ } = createScrollSignals();
      context.store.set(setScrollContainer$, container);

      expect(observed).toHaveLength(1);
      expect(observed[0]).toBe(container);
    } finally {
      globalThis.ResizeObserver = originalRO;
    }
  });
});

// VC-SCROLL-003: autoScroll$ respects disabled state
describe("createScrollSignals - autoScroll$ gate", () => {
  it("does not scroll when user has scrolled up (VC-SCROLL-003)", () => {
    const container = document.createElement("div");
    const inner = document.createElement("div");
    container.appendChild(inner);
    document.body.appendChild(container);

    Object.defineProperty(container, "scrollHeight", {
      get: () => {
        return 1000;
      },
      configurable: true,
    });
    Object.defineProperty(container, "clientHeight", {
      get: () => {
        return 300;
      },
      configurable: true,
    });

    const { setScrollContainer$, autoScroll$ } = createScrollSignals();
    context.store.set(setScrollContainer$, container);

    // Simulate user scrolling down then up to disable auto-scroll
    container.scrollTop = 500;
    container.dispatchEvent(new Event("scroll"));
    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll"));

    // autoScroll$ should be a no-op since the user scrolled up
    context.store.set(autoScroll$);
    expect(container.scrollTop).toBe(200);
  });

  it("scrolls to bottom when near bottom (VC-SCROLL-004)", () => {
    const container = document.createElement("div");
    const inner = document.createElement("div");
    container.appendChild(inner);
    document.body.appendChild(container);

    Object.defineProperty(container, "scrollHeight", {
      get: () => {
        return 1000;
      },
      configurable: true,
    });
    Object.defineProperty(container, "clientHeight", {
      get: () => {
        return 300;
      },
      configurable: true,
    });

    const { setScrollContainer$, autoScroll$ } = createScrollSignals();
    context.store.set(setScrollContainer$, container);

    // Position near the bottom (within threshold)
    container.scrollTop = 695;
    container.dispatchEvent(new Event("scroll"));

    context.store.set(autoScroll$);
    expect(container.scrollTop).toBe(1000);
  });
});

// VC-SCROLL-005: scrollToBottom$ always works regardless of disabled state
describe("createScrollSignals - scrollToBottom$ unconditional", () => {
  it("scrolls to bottom even when auto-scroll is disabled (VC-SCROLL-005)", () => {
    const container = document.createElement("div");
    const inner = document.createElement("div");
    container.appendChild(inner);
    document.body.appendChild(container);

    Object.defineProperty(container, "scrollHeight", {
      get: () => {
        return 1000;
      },
      configurable: true,
    });
    Object.defineProperty(container, "clientHeight", {
      get: () => {
        return 300;
      },
      configurable: true,
    });

    const { setScrollContainer$, scrollToBottom$ } = createScrollSignals();
    context.store.set(setScrollContainer$, container);

    // Disable auto-scroll by scrolling up
    container.scrollTop = 500;
    container.dispatchEvent(new Event("scroll"));
    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll"));

    // scrollToBottom$ ignores disabled state
    context.store.set(scrollToBottom$);
    expect(container.scrollTop).toBe(1000);
  });
});
