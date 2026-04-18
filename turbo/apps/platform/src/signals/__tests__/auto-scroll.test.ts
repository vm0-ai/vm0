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

    // Simulate user scrolling down then up to disable auto-scroll.
    // Fire a wheel event first so the scroll listener recognizes the
    // subsequent decrease in scrollTop as a genuine user interaction.
    container.scrollTop = 500;
    container.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(new Event("wheel"));
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

// VC-SCROLL-011: browser-initiated scrollTop decrease (no user input) does NOT
// disable auto-scroll. The scroll anchor or layout clamping can shift scrollTop
// without any user gesture; those shifts must be ignored so that subsequent
// autoScroll$ calls can still snap to the bottom.
describe("createScrollSignals - browser-initiated scroll does not disable auto-scroll", () => {
  it("auto-scroll stays enabled when scrollTop decreases without a user input event (VC-SCROLL-011)", () => {
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

    // Simulate scrollTop decreasing due to browser layout (no wheel/pointer/key
    // event precedes the scroll). This mimics scroll-anchor clamping or content
    // shrinkage — NOT a deliberate user scroll-up.
    container.scrollTop = 500;
    container.dispatchEvent(new Event("scroll"));
    // No user-input event fired here — purely browser-initiated
    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll"));

    // autoScroll$ should still execute — auto-scroll was NOT disabled
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

    // Disable auto-scroll by scrolling up (with wheel event to mimic real user input)
    container.scrollTop = 500;
    container.dispatchEvent(new Event("scroll"));
    container.dispatchEvent(new Event("wheel"));
    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll"));

    // scrollToBottom$ ignores disabled state
    context.store.set(scrollToBottom$);
    expect(container.scrollTop).toBe(1000);
  });
});

// VC-SCROLL-006: scroll position is persisted by id across container re-binds
describe("createScrollSignals - scroll position persistence", () => {
  function mountContainer(id: string) {
    const container = document.createElement("div");
    container.dataset.testId = id;
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
    return container;
  }

  it("restores saved position on first scrollToBottom$ when id matches (VC-SCROLL-006)", () => {
    const threadId = `thread-${Math.random().toString(36).slice(2)}`;

    // First mount: user scrolls up to a non-bottom position.
    const first = mountContainer(threadId);
    {
      const { setScrollContainer$ } = createScrollSignals(threadId);
      context.store.set(setScrollContainer$, first);

      first.scrollTop = 700;
      first.dispatchEvent(new Event("scroll"));
      first.dispatchEvent(new Event("wheel"));
      first.scrollTop = 250;
      first.dispatchEvent(new Event("scroll"));
    }

    // Second mount (simulates switching away and back): the first
    // scrollToBottom$ call should restore 250 instead of going to 1000.
    const second = mountContainer(threadId);
    const { setScrollContainer$, scrollToBottom$ } =
      createScrollSignals(threadId);
    context.store.set(setScrollContainer$, second);
    context.store.set(scrollToBottom$);

    expect(second.scrollTop).toBe(250);
  });

  it("does not restore when id is omitted (VC-SCROLL-007)", () => {
    const first = mountContainer("no-id");
    {
      const { setScrollContainer$ } = createScrollSignals();
      context.store.set(setScrollContainer$, first);

      first.scrollTop = 700;
      first.dispatchEvent(new Event("scroll"));
      first.dispatchEvent(new Event("wheel"));
      first.scrollTop = 250;
      first.dispatchEvent(new Event("scroll"));
    }

    const second = mountContainer("no-id");
    const { setScrollContainer$, scrollToBottom$ } = createScrollSignals();
    context.store.set(setScrollContainer$, second);
    context.store.set(scrollToBottom$);

    expect(second.scrollTop).toBe(1000);
  });

  it("clears cached position when user scrolls back to bottom (VC-SCROLL-008)", () => {
    const threadId = `thread-${Math.random().toString(36).slice(2)}`;

    const first = mountContainer(threadId);
    {
      const { setScrollContainer$ } = createScrollSignals(threadId);
      context.store.set(setScrollContainer$, first);

      // User scrolls up, then back down to bottom.
      first.scrollTop = 700;
      first.dispatchEvent(new Event("scroll"));
      first.dispatchEvent(new Event("wheel"));
      first.scrollTop = 250;
      first.dispatchEvent(new Event("scroll"));
      first.scrollTop = 695;
      first.dispatchEvent(new Event("scroll"));
    }

    // Because the cache was cleared, the next mount should go to bottom.
    const second = mountContainer(threadId);
    const { setScrollContainer$, scrollToBottom$ } =
      createScrollSignals(threadId);
    context.store.set(setScrollContainer$, second);
    context.store.set(scrollToBottom$);

    expect(second.scrollTop).toBe(1000);
  });

  it("re-applies saved position via ResizeObserver when content grows after restore (VC-SCROLL-010)", () => {
    const threadId = `thread-${Math.random().toString(36).slice(2)}`;

    // Seed a saved position against a normal-sized container.
    const first = mountContainer(threadId);
    {
      const { setScrollContainer$ } = createScrollSignals(threadId);
      context.store.set(setScrollContainer$, first);

      first.scrollTop = 700;
      first.dispatchEvent(new Event("scroll"));
      first.dispatchEvent(new Event("wheel"));
      first.scrollTop = 500;
      first.dispatchEvent(new Event("scroll"));
    }

    // Second mount: container starts with scrollHeight too small to hold the
    // saved position, simulating the DOM not yet having rendered messages on
    // initial page mount. Capture the ResizeObserver callback so we can fire
    // it manually after "content grows".
    let roCallback: ResizeObserverCallback | null = null;
    const originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const second = document.createElement("div");
      const inner = document.createElement("div");
      second.appendChild(inner);
      document.body.appendChild(second);

      let scrollHeight = 300; // DOM empty: scrollTop will clamp to 0
      Object.defineProperty(second, "scrollHeight", {
        get: () => {
          return scrollHeight;
        },
        configurable: true,
      });
      Object.defineProperty(second, "clientHeight", {
        get: () => {
          return 300;
        },
        configurable: true,
      });

      const { setScrollContainer$, scrollToBottom$ } =
        createScrollSignals(threadId);
      context.store.set(setScrollContainer$, second);

      // Initial restore is issued while the DOM is still short. Simulate
      // the browser clamping scrollTop to the current max (0 when empty).
      context.store.set(scrollToBottom$);
      second.scrollTop = 0;

      // Messages render — content grows and ResizeObserver fires. The saved
      // position (500) should now be re-applied since scrollHeight is large
      // enough to accommodate it.
      scrollHeight = 1000;
      if (!roCallback) {
        throw new Error("ResizeObserver callback not captured");
      }
      (roCallback as ResizeObserverCallback)(
        [],
        {} as unknown as ResizeObserver,
      );
      expect(second.scrollTop).toBe(500);
    } finally {
      globalThis.ResizeObserver = originalRO;
    }
  });

  it("second scrollToBottom$ call after restore goes to bottom (VC-SCROLL-009)", () => {
    const threadId = `thread-${Math.random().toString(36).slice(2)}`;

    const first = mountContainer(threadId);
    {
      const { setScrollContainer$ } = createScrollSignals(threadId);
      context.store.set(setScrollContainer$, first);

      first.scrollTop = 700;
      first.dispatchEvent(new Event("scroll"));
      first.dispatchEvent(new Event("wheel"));
      first.scrollTop = 250;
      first.dispatchEvent(new Event("scroll"));
    }

    const second = mountContainer(threadId);
    const { setScrollContainer$, scrollToBottom$ } =
      createScrollSignals(threadId);
    context.store.set(setScrollContainer$, second);

    // First call restores.
    context.store.set(scrollToBottom$);
    expect(second.scrollTop).toBe(250);

    // Second call (e.g. user sent a new message) scrolls all the way down.
    context.store.set(scrollToBottom$);
    expect(second.scrollTop).toBe(1000);
  });

  it("restores saved position when ResizeObserver fires before scrollToBottom$ (VC-SCROLL-011)", () => {
    const threadId = `thread-${Math.random().toString(36).slice(2)}`;

    // Seed a saved position against a normal-sized container.
    const first = mountContainer(threadId);
    {
      const { setScrollContainer$ } = createScrollSignals(threadId);
      context.store.set(setScrollContainer$, first);

      first.scrollTop = 700;
      first.dispatchEvent(new Event("scroll"));
      first.dispatchEvent(new Event("wheel"));
      first.scrollTop = 250;
      first.dispatchEvent(new Event("scroll"));
    }

    // Simulate the real chat-page flow: ResizeObserver fires as messages
    // render — BEFORE the caller gets to invoke scrollToBottom$ (which is
    // awaited behind groupedChatMessages$ in chat-page-setup).
    let roCallback: ResizeObserverCallback | null = null;
    const originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const second = document.createElement("div");
      const inner = document.createElement("div");
      second.appendChild(inner);
      document.body.appendChild(second);

      let scrollHeight = 300;
      Object.defineProperty(second, "scrollHeight", {
        get: () => {
          return scrollHeight;
        },
        configurable: true,
      });
      Object.defineProperty(second, "clientHeight", {
        get: () => {
          return 300;
        },
        configurable: true,
      });

      const { setScrollContainer$, scrollToBottom$ } =
        createScrollSignals(threadId);
      context.store.set(setScrollContainer$, second);

      // Messages render, ResizeObserver fires. Must NOT scroll to bottom
      // (which would trigger onScroll → clearCachedScrollTop and wipe the
      // restore target).
      scrollHeight = 1000;
      if (!roCallback) {
        throw new Error("ResizeObserver callback not captured");
      }
      (roCallback as ResizeObserverCallback)(
        [],
        {} as unknown as ResizeObserver,
      );

      // chat-page-setup fires scrollToBottom$ after awaiting messages.
      context.store.set(scrollToBottom$);

      expect(second.scrollTop).toBe(250);
    } finally {
      globalThis.ResizeObserver = originalRO;
    }
  });
});
