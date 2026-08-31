import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  mockResizeObserver,
} from "./chat-lifecycle-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000806";
const GEOMETRY_THREAD_ID = "b0000000-0000-4000-a000-000000000807";

const VIEWPORT_PX = 600;
const RAIL_PX = 600;
const TURN_PX = 200;
/** Enough turns to overflow the 24-tick window and force paging. */
const LONG_TURN_COUNT = 30;
const TURN_SELECTOR = '[data-role="user"], [data-role="assistant"]';

/**
 * happy-dom has no layout engine, so the locator would measure every element
 * as zero-sized and never open. This models the one layout it cares about: a
 * fixed-height viewport scrolling over turns of equal height.
 */
function stubLayout(): void {
  const prototype = globalThis.HTMLElement.prototype;
  const rectDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "getBoundingClientRect",
  );
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "clientHeight",
  );
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "scrollHeight",
  );
  const originalRect = prototype.getBoundingClientRect;
  const scrollTops = new WeakMap<HTMLElement, number>();

  const isScroller = (element: HTMLElement) => {
    return Object.hasOwn(element.dataset, "scrollContainer");
  };
  const isRail = (element: HTMLElement) => {
    return Object.hasOwn(element.dataset, "conversationLocator");
  };
  const turnIndexOf = (element: HTMLElement) => {
    const scroller = element.closest<HTMLElement>("[data-scroll-container]");
    if (!scroller || !element.matches(TURN_SELECTOR)) {
      return -1;
    }
    return [...scroller.querySelectorAll<HTMLElement>(TURN_SELECTOR)].indexOf(
      element,
    );
  };

  Object.defineProperty(prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement): number {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTops.set(this, Math.max(0, value));
    },
  });
  Object.defineProperty(prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (isScroller(this)) {
        return VIEWPORT_PX;
      }
      return isRail(this) ? RAIL_PX : 0;
    },
  });
  Object.defineProperty(prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (!isScroller(this)) {
        return 0;
      }
      return this.querySelectorAll(TURN_SELECTOR).length * TURN_PX;
    },
  });
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const rect = (top: number, height: number) => {
        return {
          top,
          bottom: top + height,
          left: 0,
          right: 0,
          width: 0,
          height,
          x: 0,
          y: top,
          toJSON: () => {
            return {};
          },
        } as DOMRect;
      };
      if (isScroller(this)) {
        return rect(0, VIEWPORT_PX);
      }
      if (isRail(this)) {
        return rect(0, RAIL_PX);
      }
      const index = turnIndexOf(this);
      if (index < 0) {
        return originalRect.call(this);
      }
      const scroller = this.closest<HTMLElement>("[data-scroll-container]");
      return rect(index * TURN_PX - (scroller?.scrollTop ?? 0), TURN_PX);
    },
  });

  const restore = (
    name: string,
    descriptor: PropertyDescriptor | undefined,
  ) => {
    if (descriptor) {
      Object.defineProperty(prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(prototype, name);
    }
  };
  context.signal.addEventListener(
    "abort",
    () => {
      restore("getBoundingClientRect", rectDescriptor);
      restore("clientHeight", clientHeightDescriptor);
      restore("scrollHeight", scrollHeightDescriptor);
      Reflect.deleteProperty(prototype, "scrollTop");
    },
    { once: true },
  );
}

function longConversation(): MockChatEventInput[] {
  return Array.from({ length: LONG_TURN_COUNT }, (_unused, index) => {
    const minute = String(index).padStart(2, "0");
    return {
      id: `locator-long-${index}`,
      eventType: "input.prompt" as const,
      role: "user" as const,
      content: `Prompt ${index}`,
      createdAt: `2026-06-09T11:${minute}:00Z`,
    };
  });
}

function pointerAt(rail: HTMLElement, y: number, type: string): void {
  rail.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: 20, clientY: y }),
  );
}

function ticksOf(rail: HTMLElement): HTMLElement[] {
  return [...rail.querySelectorAll<HTMLElement>("[data-locator-tick]")];
}

async function renderLongThread(): Promise<{
  rail: HTMLElement;
  resize: { automationAll: () => void };
}> {
  stubLayout();
  const resize = mockResizeObserver();
  mockChatLifecycle(context, {
    threadId: GEOMETRY_THREAD_ID,
    threadTitle: "Locator geometry",
    chatEvents: longConversation(),
  });
  detachedSetupPage({
    context,
    path: `/chats/${GEOMETRY_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatConversationLocator]: true,
    },
  });

  await screen.findByText(`Prompt ${LONG_TURN_COUNT - 1}`);
  const rail = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      "[data-conversation-locator]",
    );
    expect(element).not.toBeNull();
    return element as HTMLElement;
  });
  // The turns render after the rail binds, so nudge the observer the locator
  // relies on for reflow instead of waiting on a resize happy-dom never emits.
  resize.automationAll();
  await waitFor(() => {
    expect(ticksOf(rail).length).toBeGreaterThan(0);
  });
  return { rail, resize };
}

/** Ten alternating turns: past the locator's turn floor on its own. */
function conversation(): MockChatEventInput[] {
  const events: MockChatEventInput[] = [];
  for (let index = 0; index < 5; index += 1) {
    const minute = String(index).padStart(2, "0");
    events.push(
      {
        id: `locator-prompt-${index}`,
        eventType: "input.prompt",
        role: "user",
        content: `Question ${index}`,
        createdAt: `2026-06-09T10:${minute}:00Z`,
      },
      {
        id: `locator-reply-${index}`,
        eventType: "output.message",
        role: "assistant",
        content: `Answer ${index}`,
        runId: `run-locator-${index}`,
        createdAt: `2026-06-09T10:${minute}:30Z`,
      },
    );
  }
  return events;
}

function renderThread(enabled: boolean): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Conversation locator",
    chatEvents: conversation(),
  });
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatConversationLocator]: enabled,
    },
  });
}

describe("chat conversation locator", () => {
  it("stays out of the thread while the feature switch is off", async () => {
    renderThread(false);

    await screen.findByText("Answer 4", {}, { timeout: 3000 });
    expect(document.querySelector("[data-conversation-locator]")).toBeNull();
    expect(
      document.querySelector("[data-conversation-locator-preview]"),
    ).toBeNull();
  });

  it("mounts the rail and its preview card once the switch is on", async () => {
    renderThread(true);

    await screen.findByText("Answer 4");
    const rail = await waitFor(() => {
      const element = document.querySelector("[data-conversation-locator]");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    // The rail is a pointer-only shortcut to turns the thread already lists in
    // order, so it must not add a control to the accessibility tree.
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    expect(
      document.querySelector("[data-conversation-locator-preview]"),
    ).not.toBeNull();
  });

  it("draws no ticks until the thread outgrows the viewport", async () => {
    renderThread(true);

    await screen.findByText("Answer 4");
    const rail = await waitFor(() => {
      const element = document.querySelector("[data-conversation-locator]");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    // Turn count alone does not open the rail: the thread also has to be
    // taller than a few viewports, and an unlaid-out container never is.
    expect(rail.querySelectorAll("[data-locator-tick]")).toHaveLength(0);
    expect(rail.className).toContain("opacity-0");
  });

  it("stamps every turn with the timestamp the preview card reads", async () => {
    renderThread(true);

    await screen.findByText("Answer 4");
    const turns = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-role="user"], [data-role="assistant"]',
      ),
    ];
    expect(turns.length).toBeGreaterThan(0);
    // The locator reads timestamps off the turn wrappers rather than the group
    // signals, so every wrapper it can point at has to carry a parseable one.
    for (const turn of turns) {
      expect(
        Number.isNaN(Date.parse(turn.dataset.turnCreatedAt ?? "")),
      ).toBeFalsy();
    }
    expect(
      turns.some((turn) => {
        return turn.dataset.role === "user";
      }),
    ).toBeTruthy();
    expect(
      turns.some((turn) => {
        return turn.dataset.role === "assistant";
      }),
    ).toBeTruthy();
    // The thinking indicator also carries data-role but is not a turn, and it
    // is excluded by the exact-value selector rather than by a timestamp.
    const thinking = document.querySelector<HTMLElement>(
      '[data-role="assistant-thinking"]',
    );
    expect(thinking?.dataset.turnCreatedAt).toBeUndefined();
  });

  it("caps the rail at 24 evenly spaced ticks over a longer thread", async () => {
    const { rail } = await renderLongThread();

    const ticks = ticksOf(rail);
    // 30 turns, 24 ticks: the rail pages rather than packing tighter.
    expect(ticks).toHaveLength(24);

    const tops = ticks.map((tick) => {
      return Number.parseFloat(tick.style.top);
    });
    const gaps = new Set(
      tops.slice(1).map((top, index) => {
        return top - (tops[index] ?? 0);
      }),
    );
    // One pitch for the whole rail, and a whole number of pixels: a bar on a
    // half pixel renders as a blurred triple line.
    expect([...gaps]).toStrictEqual([10]);
    for (const top of tops) {
      expect(Number.isInteger(top)).toBeTruthy();
    }

    // Two discrete lengths, both tied to the role rather than to content.
    const widths = new Set(
      ticks.map((tick) => {
        return `${tick.dataset.locatorTick}:${tick.style.width}`;
      }),
    );
    expect([...widths].sort()).toStrictEqual(["user:7px"]);
  });

  it("magnifies neighbours but marks only the tick under the cursor", async () => {
    const { rail } = await renderLongThread();

    const ticks = ticksOf(rail);
    const target = ticks[12] as HTMLElement;
    pointerAt(rail, 0, "pointerenter");
    pointerAt(rail, Number.parseFloat(target.style.top), "pointermove");

    await waitFor(() => {
      expect(rail.querySelectorAll("[data-locator-hot]")).toHaveLength(1);
    });
    expect(target.dataset.locatorHot).toBe("");

    const widthOf = (tick: HTMLElement) => {
      return Number.parseFloat(tick.style.width);
    };
    const hotWidth = widthOf(target);
    const neighbourWidth = widthOf(ticks[13] as HTMLElement);
    const farWidth = widthOf(ticks[23] as HTMLElement);
    // Size falls off with distance, so a neighbour grows too...
    expect(hotWidth).toBeGreaterThan(neighbourWidth);
    expect(neighbourWidth).toBeGreaterThan(farWidth);
    // ...but the selected state belongs to one tick alone, and thickness
    // never moves.
    expect(ticks[13]?.dataset.locatorHot).toBeUndefined();
    for (const tick of ticks) {
      expect(tick.className).toContain("h-0.5");
    }
  });

  it("pages the window on wheel and hands it back when the pointer leaves", async () => {
    const { rail } = await renderLongThread();

    const firstIndex = () => {
      const tick = ticksOf(rail)[0];
      return Number.parseFloat(tick?.dataset.turnIndex ?? "-1");
    };
    pointerAt(rail, 0, "pointerenter");
    pointerAt(rail, 200, "pointermove");
    await waitFor(() => {
      expect(rail.querySelectorAll("[data-locator-hot]")).toHaveLength(1);
    });

    // A freshly opened thread sits at its tail, so the window starts at the
    // end of the turns and can only be paged backward.
    const before = firstIndex();
    expect(before).toBeGreaterThan(0);
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -300,
    });
    rail.dispatchEvent(wheel);
    // The rail owns the wheel while it is showing a window, so the thread
    // underneath must not scroll with it.
    expect(wheel.defaultPrevented).toBeTruthy();
    await waitFor(() => {
      expect(firstIndex()).toBeLessThan(before);
    });

    pointerAt(rail, 200, "pointerleave");
    await waitFor(() => {
      expect(firstIndex()).toBe(before);
    });
  });

  it("marks the turn a click lands on", async () => {
    const { rail } = await renderLongThread();

    const target = ticksOf(rail)[8] as HTMLElement;
    pointerAt(rail, 0, "pointerenter");
    pointerAt(rail, Number.parseFloat(target.style.top), "pointermove");
    await waitFor(() => {
      expect(rail.querySelectorAll("[data-locator-hot]")).toHaveLength(1);
    });
    rail.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => {
      expect(document.querySelectorAll("[data-locator-landed]")).toHaveLength(
        1,
      );
    });
  });

  it("moves the landed mark when a later jump replaces it", async () => {
    const { rail } = await renderLongThread();

    const firstTarget = ticksOf(rail)[8] as HTMLElement;
    const secondTarget = ticksOf(rail)[12] as HTMLElement;
    pointerAt(rail, 0, "pointerenter");
    pointerAt(rail, Number.parseFloat(firstTarget.style.top), "pointermove");
    await waitFor(() => {
      expect(firstTarget.dataset.locatorHot).toBe("");
    });
    rail.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const firstLanded = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        "[data-locator-landed]",
      );
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    pointerAt(rail, Number.parseFloat(secondTarget.style.top), "pointermove");
    await waitFor(() => {
      expect(secondTarget.dataset.locatorHot).toBe("");
    });
    rail.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => {
      const landed = document.querySelectorAll("[data-locator-landed]");
      expect(landed).toHaveLength(1);
      expect(landed[0]).not.toBe(firstLanded);
    });
  });
});
