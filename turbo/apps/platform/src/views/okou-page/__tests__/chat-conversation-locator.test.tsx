import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  mockResizeObserver,
} from "./chat-lifecycle-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000806";
const GEOMETRY_THREAD_ID = "b0000000-0000-4000-a000-000000000807";
const VIRTUAL_THREAD_ID = "b0000000-0000-4000-a000-000000000808";
const GOAL_THREAD_ID = "b0000000-0000-4000-a000-000000000809";
const COMPLETED_WORK_THREAD_ID = "b0000000-0000-4000-a000-000000000810";

const VIEWPORT_PX = 600;
const RAIL_PX = 600;
const TURN_PX = 200;
/** Enough turns to overflow the 24-tick window and force paging. */
const LONG_TURN_COUNT = 30;
const TURN_SELECTOR = '[data-role="user"], [data-role="assistant"]';

interface RecordedScrollRequest {
  readonly top: number;
  readonly behavior: ScrollBehavior | undefined;
  readonly renderedEventIds: readonly string[];
}

/**
 * happy-dom has no layout engine, so the locator would measure every element
 * as zero-sized and never open. This models the one layout it cares about: a
 * fixed-height viewport scrolling over turns of equal height.
 */
function stubLayout({
  minimumScrollTurns = 0,
  turnHeight = TURN_PX,
}: {
  minimumScrollTurns?: number;
  turnHeight?: number;
} = {}): RecordedScrollRequest[] {
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
  const scrollToDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "scrollTo",
  );
  const originalRect = prototype.getBoundingClientRect;
  const scrollTops = new WeakMap<HTMLElement, number>();
  const scrollRequests: RecordedScrollRequest[] = [];

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
      const stored = scrollTops.get(this) ?? 0;
      if (!isScroller(this)) {
        return stored;
      }
      // The thread pins itself to the bottom by assigning scrollHeight, so
      // without a browser's clamp the viewport would read as parked a whole
      // screen past the last turn.
      return Math.min(stored, Math.max(0, this.scrollHeight - VIEWPORT_PX));
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
      return (
        Math.max(
          minimumScrollTurns,
          this.querySelectorAll(TURN_SELECTOR).length,
        ) * turnHeight
      );
    },
  });
  Object.defineProperty(prototype, "scrollTo", {
    configurable: true,
    value(
      this: HTMLElement,
      optionsOrX: ScrollToOptions | number,
      y?: number,
    ): void {
      const top =
        typeof optionsOrX === "number"
          ? (y ?? this.scrollTop)
          : (optionsOrX.top ?? this.scrollTop);
      scrollRequests.push({
        top,
        behavior:
          typeof optionsOrX === "number" ? undefined : optionsOrX.behavior,
        renderedEventIds: [
          ...this.querySelectorAll<HTMLElement>(
            "[data-chat-scroll-anchor-event-id]",
          ),
        ].flatMap((element) => {
          const eventId = element.dataset.chatScrollAnchorEventId;
          return eventId ? [eventId] : [];
        }),
      });
      this.scrollTop = top;
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
      return rect(index * turnHeight - (scroller?.scrollTop ?? 0), turnHeight);
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
      restore("scrollTo", scrollToDescriptor);
      Reflect.deleteProperty(prototype, "scrollTop");
    },
    { once: true },
  );
  return scrollRequests;
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

function virtualConversation(): MockChatEventInput[] {
  return Array.from({ length: 15 }, (_unused, index) => {
    const minute = String(index).padStart(2, "0");
    const runId = `run-locator-virtual-${index}`;
    return [
      {
        id: `locator-virtual-user-${index}`,
        eventType: "input.prompt" as const,
        role: "user" as const,
        content: `Virtual question ${index}`,
        runId,
        createdAt: `2026-06-09T12:${minute}:00Z`,
      },
      {
        id: `locator-virtual-assistant-${index}`,
        eventType: "output.message" as const,
        role: "assistant" as const,
        content: `Virtual answer ${index}`,
        runId,
        createdAt: `2026-06-09T12:${minute}:30Z`,
      },
    ];
  }).flat();
}

function goalConversation(): MockChatEventInput[] {
  const prefix = Array.from({ length: 5 }, (_unused, index) => {
    const minute = String(index).padStart(2, "0");
    const runId = `run-locator-goal-prefix-${index}`;
    return [
      {
        id: `locator-goal-prefix-user-${index}`,
        eventType: "input.prompt" as const,
        role: "user" as const,
        content: `Goal prefix question ${index}`,
        runId,
        createdAt: `2026-06-09T13:${minute}:00Z`,
      },
      {
        id: `locator-goal-prefix-assistant-${index}`,
        eventType: "output.message" as const,
        role: "assistant" as const,
        content: `Goal prefix answer ${index}`,
        runId,
        createdAt: `2026-06-09T13:${minute}:30Z`,
      },
    ];
  }).flat();
  const runGroupId = "run-group-locator-goal";
  const goalBrief = "Keep the locator goal moving";
  return [
    ...prefix,
    {
      id: "locator-goal-hidden-user",
      role: "user",
      content: goalBrief,
      userMessage: {
        version: 1,
        parts: [{ type: "goal", goalBrief }],
      },
      runId: "run-locator-goal-hidden",
      runGroupId,
      createdAt: "2026-06-09T13:10:00Z",
    },
    {
      id: "locator-goal-hidden-assistant",
      role: "assistant",
      content: "First goal result in the locator",
      runId: "run-locator-goal-hidden",
      runGroupId,
      createdAt: "2026-06-09T13:10:30Z",
    },
    {
      id: "locator-goal-latest-user",
      role: "user",
      content: goalBrief,
      userMessage: {
        version: 1,
        parts: [{ type: "goal", goalBrief }],
      },
      runId: "run-locator-goal-latest",
      runGroupId,
      createdAt: "2026-06-09T13:12:00Z",
    },
    {
      id: "locator-goal-latest-assistant",
      role: "assistant",
      content: "Latest goal result in the locator",
      runId: "run-locator-goal-latest",
      runGroupId,
      runLifecycleEvent: "completed",
      createdAt: "2026-06-09T13:12:30Z",
    },
  ];
}

function completedWorkConversation(): MockChatEventInput[] {
  const prefix = Array.from({ length: 5 }, (_unused, index) => {
    const minute = String(index).padStart(2, "0");
    const runId = `run-locator-work-prefix-${index}`;
    return [
      {
        id: `locator-work-prefix-user-${index}`,
        eventType: "input.prompt" as const,
        role: "user" as const,
        content: `Work prefix question ${index}`,
        runId,
        createdAt: `2026-06-09T14:${minute}:00Z`,
      },
      {
        id: `locator-work-prefix-assistant-${index}`,
        eventType: "output.message" as const,
        role: "assistant" as const,
        content: `Work prefix answer ${index}`,
        runId,
        createdAt: `2026-06-09T14:${minute}:30Z`,
      },
    ];
  }).flat();
  const runId = "run-locator-completed-work";
  return [
    ...prefix,
    {
      id: "locator-work-user",
      eventType: "input.prompt",
      role: "user",
      content: "Summarize completed work",
      runId,
      createdAt: "2026-06-09T14:10:00Z",
    },
    {
      id: "locator-work-hidden-assistant",
      eventType: "output.message",
      role: "assistant",
      content: "Checking completed work in the locator",
      runId,
      createdAt: "2026-06-09T14:10:30Z",
    },
    {
      id: "locator-work-final-assistant",
      eventType: "output.message",
      role: "assistant",
      content: "Completed work is summarized in the locator",
      runId,
      runLifecycleEvent: "completed",
      createdAt: "2026-06-09T14:11:00Z",
    },
  ];
}

function pointerAt(rail: HTMLElement, y: number, type: string): void {
  rail.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: 20, clientY: y }),
  );
}

function ticksOf(rail: HTMLElement): HTMLElement[] {
  return [...rail.querySelectorAll<HTMLElement>("[data-locator-tick]")];
}

function locatorPreview(): HTMLElement {
  const preview = document.querySelector<HTMLElement>(
    "[data-conversation-locator-preview]",
  );
  expect(preview).not.toBeNull();
  return preview as HTMLElement;
}

async function renderMeasuredThread({
  threadId,
  threadTitle,
  chatEvents,
  renderedText,
  minimumScrollTurns = 0,
  turnHeight = TURN_PX,
}: {
  threadId: string;
  threadTitle: string;
  chatEvents: MockChatEventInput[];
  renderedText: string;
  minimumScrollTurns?: number;
  turnHeight?: number;
}): Promise<{
  rail: HTMLElement;
  resize: { automationAll: () => void };
  scrollRequests: RecordedScrollRequest[];
}> {
  const scrollRequests = stubLayout({ minimumScrollTurns, turnHeight });
  const resize = mockResizeObserver();
  mockChatLifecycle(context, {
    threadId,
    threadTitle,
    chatEvents,
  });
  detachedSetupPage({
    context,
    path: `/chats/${threadId}`,
  });

  await screen.findByText(renderedText);
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
  return { rail, resize, scrollRequests };
}

function renderLongThread(): Promise<{
  rail: HTMLElement;
  resize: { automationAll: () => void };
  scrollRequests: RecordedScrollRequest[];
}> {
  return renderMeasuredThread({
    threadId: GEOMETRY_THREAD_ID,
    threadTitle: "Locator geometry",
    chatEvents: longConversation(),
    renderedText: `Prompt ${LONG_TURN_COUNT - 1}`,
  });
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

function renderThread(): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Conversation locator",
    chatEvents: conversation(),
  });
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });
}

describe("chat conversation locator", () => {
  it("mounts the rail and its preview card", async () => {
    renderThread();

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
    renderThread();

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
    renderThread();

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

  it("widens the viewport band with the ticks it frames", async () => {
    const { rail } = await renderLongThread();

    const bandElement = await waitFor(() => {
      const element = rail.querySelector<HTMLElement>(
        "[data-conversation-locator-band]",
      );
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    const bandWidth = () => {
      return Number.parseFloat(bandElement.style.width);
    };
    const widestFramedTick = () => {
      const top = Number.parseFloat(bandElement.style.top);
      const bottom = top + Number.parseFloat(bandElement.style.height);
      return Math.max(
        ...ticksOf(rail)
          .filter((tick) => {
            const y = Number.parseFloat(tick.style.top);
            return y >= top && y <= bottom;
          })
          .map((tick) => {
            return Number.parseFloat(tick.style.width);
          }),
      );
    };

    expect(bandWidth()).toBe(32);

    // A freshly opened thread sits at its tail, so the band frames the last
    // ticks and the cursor can land on one of them.
    const ticks = ticksOf(rail);
    const target = ticks.at(-1) as HTMLElement;
    pointerAt(rail, 0, "pointerenter");
    pointerAt(rail, Number.parseFloat(target.style.top), "pointermove");
    await waitFor(() => {
      expect(target.dataset.locatorHot).toBe("");
    });

    // The band grows by exactly what its widest tick gained, so a magnified
    // bar never spills out of the frame that marks the viewport.
    expect(widestFramedTick()).toBe(Number.parseFloat(target.style.width));
    expect(bandWidth()).toBeGreaterThan(32);
    expect(bandWidth()).toBeCloseTo(32 + widestFramedTick() - 7, 1);

    pointerAt(rail, 200, "pointerleave");
    await waitFor(() => {
      expect(bandWidth()).toBe(32);
    });
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

  it("hands the wheel back at the beginning of the locator window", async () => {
    const { rail } = await renderLongThread();

    const firstIndex = () => {
      const tick = ticksOf(rail)[0];
      return Number.parseFloat(tick?.dataset.turnIndex ?? "-1");
    };
    pointerAt(rail, 0, "pointerenter");

    rail.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -3000,
      }),
    );
    await waitFor(() => {
      expect(firstIndex()).toBe(0);
    });

    const boundaryWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -300,
    });
    rail.dispatchEvent(boundaryWheel);

    expect(boundaryWheel.defaultPrevented).toBeFalsy();
  });

  it("renders a virtual-window target before requesting its smooth jump", async () => {
    const { rail, scrollRequests } = await renderMeasuredThread({
      threadId: VIRTUAL_THREAD_ID,
      threadTitle: "Virtual locator turns",
      chatEvents: virtualConversation(),
      renderedText: "Virtual answer 14",
      turnHeight: 60,
    });

    expect(
      document.querySelector(
        '[data-chat-scroll-anchor-event-id="locator-virtual-user-8"]',
      ),
    ).toBeNull();
    expect(ticksOf(rail)).toHaveLength(24);

    pointerAt(rail, 0, "pointerenter");
    const targetTick = rail.querySelector<HTMLElement>(
      '[data-locator-tick][data-turn-index="16"]',
    );
    expect(targetTick).not.toBeNull();
    pointerAt(rail, Number.parseFloat(targetTick!.style.top), "pointermove");

    // This turn is outside the DOM render window, so naming it in the
    // preview proves the rail indexes the whole thread before the smooth jump
    // renders it.
    await waitFor(() => {
      expect(locatorPreview()).toHaveTextContent("Virtual question 8");
    });
    rail.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await screen.findByText("Virtual question 8");
    await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-chat-scroll-anchor-event-id="locator-virtual-user-8"]',
      );
      expect(target).not.toBeNull();
      expect(target).toHaveAttribute("data-locator-landed");
    });
    expect(scrollRequests).toHaveLength(1);
    expect(scrollRequests[0]).toMatchObject({
      behavior: "smooth",
      renderedEventIds: expect.arrayContaining([
        "locator-virtual-user-3",
        "locator-virtual-user-8",
      ]),
    });

    const container = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    expect(container).not.toBeNull();
    const finalScrollTop = scrollRequests[0]?.top;
    expect(finalScrollTop).toBeDefined();
    // Browsers can quantize a fractional smooth-scroll destination into a
    // near-terminal pixel followed by the final rounded pixel. Both events
    // still belong to the programmatic animation; neither may retarget the
    // virtual render window as reader input.
    container!.scrollTop = finalScrollTop! - 0.5;
    fireEvent.scroll(container!);
    container!.scrollTop = finalScrollTop!;
    fireEvent.scroll(container!);
    container!.dispatchEvent(new Event("scrollend"));
    await Promise.resolve();
    fireEvent.scroll(container!);
    // The DOM listener detaches a command that crosses the position write,
    // tree ensure, and React commit queues. Drain those owned microtasks so
    // the assertion observes the settled render window without a test timer.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      [
        ...container!.querySelectorAll<HTMLElement>(
          "[data-chat-scroll-anchor-event-id]",
        ),
      ].map((element) => {
        return element.dataset.chatScrollAnchorEventId;
      }),
    ).toStrictEqual(scrollRequests[0]?.renderedEventIds);
  });

  it("keeps merged goal turns out of the locator until the group expands", async () => {
    const { rail, resize } = await renderMeasuredThread({
      threadId: GOAL_THREAD_ID,
      threadTitle: "Goal locator turns",
      chatEvents: goalConversation(),
      renderedText: "Latest goal result in the locator",
    });

    expect(screen.queryByText("First goal result in the locator")).toBeNull();
    expect(ticksOf(rail)).toHaveLength(12);

    fireEvent.click(screen.getByLabelText("Expand grouped run history"));
    await screen.findByText("First goal result in the locator");
    resize.automationAll();
    await waitFor(() => {
      expect(ticksOf(rail)).toHaveLength(14);
    });

    const hiddenAssistantTick = ticksOf(rail).find((tick) => {
      return tick.dataset.turnIndex === "11";
    });
    expect(hiddenAssistantTick).toBeDefined();
    pointerAt(rail, 0, "pointerenter");
    pointerAt(
      rail,
      Number.parseFloat(hiddenAssistantTick!.style.top),
      "pointermove",
    );
    await waitFor(() => {
      expect(locatorPreview()).toHaveTextContent(
        "First goal result in the locator",
      );
    });
    rail.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitFor(() => {
      const anchor = document.querySelector<HTMLElement>(
        '[data-chat-scroll-anchor-event-id="locator-goal-hidden-assistant"]',
      );
      const landed = anchor?.closest<HTMLElement>('[data-role="assistant"]');
      expect(landed).not.toBeNull();
      expect(landed).toHaveAttribute("data-locator-landed");
    });
  });

  it("tracks the visible assistant event in folded completed work", async () => {
    const { rail, resize } = await renderMeasuredThread({
      threadId: COMPLETED_WORK_THREAD_ID,
      threadTitle: "Completed work locator turns",
      chatEvents: completedWorkConversation(),
      renderedText: "Completed work is summarized in the locator",
    });

    expect(
      screen.queryByText("Checking completed work in the locator"),
    ).toBeNull();
    expect(ticksOf(rail)).toHaveLength(12);

    pointerAt(rail, 0, "pointerenter");
    let assistantTick = ticksOf(rail).find((tick) => {
      return tick.dataset.turnIndex === "11";
    });
    expect(assistantTick).toBeDefined();
    pointerAt(rail, Number.parseFloat(assistantTick!.style.top), "pointermove");
    await waitFor(() => {
      expect(locatorPreview()).toHaveTextContent(
        "Completed work is summarized in the locator",
      );
    });
    rail.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const anchor = document.querySelector<HTMLElement>(
        '[data-chat-scroll-anchor-event-id="locator-work-final-assistant"]',
      );
      expect(anchor?.closest('[data-role="assistant"]')).toHaveAttribute(
        "data-locator-landed",
      );
    });

    fireEvent.click(screen.getByLabelText("Expand work history"));
    await screen.findByText("Checking completed work in the locator");
    resize.automationAll();
    await waitFor(() => {
      expect(ticksOf(rail)).toHaveLength(12);
    });

    assistantTick = ticksOf(rail).find((tick) => {
      return tick.dataset.turnIndex === "11";
    });
    expect(assistantTick).toBeDefined();
    pointerAt(rail, Number.parseFloat(assistantTick!.style.top), "pointermove");
    await waitFor(() => {
      expect(locatorPreview()).toHaveTextContent(
        "Checking completed work in the locator",
      );
    });
    rail.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const anchor = document.querySelector<HTMLElement>(
        '[data-chat-scroll-anchor-event-id="locator-work-hidden-assistant"]',
      );
      expect(anchor?.closest('[data-role="assistant"]')).toHaveAttribute(
        "data-locator-landed",
      );
    });
  });

  it("smoothly jumps to a turn at 28% of the viewport", async () => {
    const { rail, scrollRequests } = await renderLongThread();

    const target = ticksOf(rail)[8] as HTMLElement;
    const targetIndex = Number(target.dataset.turnIndex);
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
    expect(scrollRequests).toStrictEqual([
      {
        top: targetIndex * TURN_PX - VIEWPORT_PX * 0.28,
        behavior: "smooth",
        renderedEventIds: expect.arrayContaining([
          `locator-long-${targetIndex}`,
        ]),
      },
    ]);
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
