import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { sendMessageInUI } from "./chat-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  KEYBOARD_CURRENT_THREAD_ID,
  KEYBOARD_PREV_THREAD_ID,
  chatScrollContainer,
  linkByText,
  mockChatLifecycleWithoutBrowserSession,
  mockKeyboardNavigationThreads,
} from "./chat-lifecycle-test-helpers.ts";

interface EventRect {
  readonly top: number;
  readonly height: number;
}

interface ThreadLayout {
  readonly clientHeight: () => number;
  readonly scrollHeight: () => number;
  readonly eventRect: (eventId: string) => EventRect | undefined;
}

interface ResizeObserverController {
  isObserved: (target: Element) => boolean;
  trigger: (target: Element) => void;
}

const CHAT_VIEWPORT_TOP = 100;

async function setupVisibleChatPage(
  options: Parameters<typeof detachedSetupPage>[0],
): Promise<void> {
  detachedSetupPage(options);
  await screen.findAllByRole("navigation", { name: "Sidebar" });
  await screen.findByRole("textbox", { name: "Message" });
}

function domRect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 900,
    toJSON: () => {
      return {};
    },
    top,
    width: 900,
    x: 0,
    y: top,
  } as DOMRect;
}

function inheritedPropertyDescriptor(
  prototype: object,
  property: PropertyKey,
): PropertyDescriptor | undefined {
  let current: object | null = prototype;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor) {
      return descriptor;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function restorePrototypeProperty(
  prototype: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(prototype, property, descriptor);
    return;
  }
  Reflect.deleteProperty(prototype, property);
}

function threadIdForElement(element: HTMLElement): string | null {
  return (
    element.closest<HTMLElement>("[data-chat-thread-container-id]")?.dataset
      .chatThreadContainerId ?? null
  );
}

function isScrollContainer(element: HTMLElement): boolean {
  return Object.hasOwn(element.dataset, "scrollContainer");
}

function installChatLayout(layouts: ReadonlyMap<string, ThreadLayout>): void {
  const prototype = HTMLElement.prototype;
  const ownScrollTopDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "scrollTop",
  );
  const ownScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "scrollHeight",
  );
  const ownClientHeightDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "clientHeight",
  );
  const ownRectDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "getBoundingClientRect",
  );
  const scrollTopDescriptor = inheritedPropertyDescriptor(
    prototype,
    "scrollTop",
  );
  const scrollHeightDescriptor = inheritedPropertyDescriptor(
    prototype,
    "scrollHeight",
  );
  const clientHeightDescriptor = inheritedPropertyDescriptor(
    prototype,
    "clientHeight",
  );
  const originalGetBoundingClientRect = prototype.getBoundingClientRect;
  const scrollTopByContainer = new WeakMap<HTMLElement, number>();

  Object.defineProperty(prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement): number {
      if (!isScrollContainer(this)) {
        return scrollTopDescriptor?.get?.call(this) as number;
      }
      const scrollTop = scrollTopByContainer.get(this) ?? 0;
      const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight);
      const clampedScrollTop = Math.min(scrollTop, maxScrollTop);
      if (clampedScrollTop !== scrollTop) {
        scrollTopByContainer.set(this, clampedScrollTop);
      }
      return clampedScrollTop;
    },
    set(this: HTMLElement, value: number) {
      if (!isScrollContainer(this)) {
        scrollTopDescriptor?.set?.call(this, value);
        return;
      }
      const threadId = threadIdForElement(this);
      const layout = threadId === null ? undefined : layouts.get(threadId);
      const maxScrollTop = layout
        ? Math.max(0, layout.scrollHeight() - layout.clientHeight())
        : Math.max(0, this.scrollHeight - this.clientHeight);
      scrollTopByContainer.set(
        this,
        Math.max(0, Math.min(value, maxScrollTop)),
      );
    },
  });
  Object.defineProperty(prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (!isScrollContainer(this)) {
        return (scrollHeightDescriptor?.get?.call(this) as number) ?? 0;
      }
      if (!this.querySelector("[data-message-container]")) {
        return this.clientHeight;
      }
      const threadId = threadIdForElement(this);
      return threadId === null
        ? 0
        : (layouts.get(threadId)?.scrollHeight() ?? 0);
    },
  });
  Object.defineProperty(prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (!isScrollContainer(this)) {
        return (clientHeightDescriptor?.get?.call(this) as number) ?? 0;
      }
      const threadId = threadIdForElement(this);
      return threadId === null
        ? 0
        : (layouts.get(threadId)?.clientHeight() ?? 0);
    },
  });
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (isScrollContainer(this)) {
        return domRect(CHAT_VIEWPORT_TOP, this.clientHeight);
      }
      const eventId = this.dataset.chatScrollAnchorEventId ?? null;
      const container = this.closest<HTMLElement>("[data-scroll-container]");
      const threadId = threadIdForElement(this);
      const layout = threadId === null ? undefined : layouts.get(threadId);
      const rect =
        eventId === null || layout === undefined
          ? undefined
          : layout.eventRect(eventId);
      if (container && rect) {
        return domRect(
          CHAT_VIEWPORT_TOP + rect.top - container.scrollTop,
          rect.height,
        );
      }
      return originalGetBoundingClientRect.call(this);
    },
  });

  context.signal.addEventListener(
    "abort",
    () => {
      restorePrototypeProperty(prototype, "scrollTop", ownScrollTopDescriptor);
      restorePrototypeProperty(
        prototype,
        "scrollHeight",
        ownScrollHeightDescriptor,
      );
      restorePrototypeProperty(
        prototype,
        "clientHeight",
        ownClientHeightDescriptor,
      );
      restorePrototypeProperty(
        prototype,
        "getBoundingClientRect",
        ownRectDescriptor,
      );
    },
    { once: true },
  );
}

function installImmediateAnimationFrames(): void {
  const requestDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const cancelDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );
  let nextFrameId = 0;

  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      nextFrameId += 1;
      callback(performance.now());
      return nextFrameId;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: (_frameId: number): void => {},
  });

  context.signal.addEventListener(
    "abort",
    () => {
      restorePrototypeProperty(
        globalThis,
        "requestAnimationFrame",
        requestDescriptor,
      );
      restorePrototypeProperty(
        globalThis,
        "cancelAnimationFrame",
        cancelDescriptor,
      );
    },
    { once: true },
  );
}

function installResizeObserver(): ResizeObserverController {
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

    isObserving(target: Element): boolean {
      return this.observedTargets.has(target);
    }

    trigger(target: Element): void {
      if (!this.observedTargets.has(target)) {
        return;
      }
      this.callback(
        [
          {
            target,
            contentRect: target.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry,
        ],
        this,
      );
    }
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
        return;
      }
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    },
    { once: true },
  );

  return {
    isObserved: (target) => {
      return observers.some((observer) => {
        return observer.isObserving(target);
      });
    },
    trigger: (target) => {
      for (const observer of observers) {
        observer.trigger(target);
      }
    },
  };
}

function eventAnchor(eventId: string): HTMLElement {
  const anchor = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-chat-scroll-anchor-event-id]",
    ),
  ).find((candidate) => {
    return candidate.dataset.chatScrollAnchorEventId === eventId;
  });
  if (!(anchor instanceof HTMLElement)) {
    throw new Error(`Chat scroll anchor not found: ${eventId}`);
  }
  return anchor;
}

function viewportOffsetTop(eventId: string): number {
  const anchor = eventAnchor(eventId);
  const container = chatScrollContainer();
  return (
    anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
  );
}

function scrollTo(container: HTMLElement, scrollTop: number): void {
  container.scrollTop = scrollTop;
  fireEvent.scroll(container);
}

function selectAssistantText(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return domRect(120, 20);
    },
  });
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Selection API is not available");
  }
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function buttonByName(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/g, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected a ${name} button`);
  }
  return button;
}

function simpleUserEvents(
  threadId: string,
  prefix: string,
  count: number,
): MockChatEventInput[] {
  return Array.from({ length: count }, (_, index) => {
    return {
      id: `${prefix}-${index}`,
      threadId,
      role: "user" as const,
      content: `${prefix} message ${index}`,
      runId: `${prefix}-run-${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 30, 10, index)).toISOString(),
    };
  });
}

function mockVirtualizedHistoryThread({
  threadId,
  prefix,
}: {
  readonly threadId: string;
  readonly prefix: string;
}): { readonly renderedStartIndex: () => number } {
  const chatEvents: ChatEvent[] = Array.from({ length: 24 }, (_, index) => {
    return {
      id: `${prefix}-${index}`,
      threadId,
      eventType: "run.completed" as const,
      content: `${prefix} reply ${index}`,
      runId: `${prefix}-run-${index}`,
      runLifecycleEvent: "completed",
      createdAt: `2026-07-30T10:${String(index).padStart(2, "0")}:00Z`,
      seqId: index + 1,
    };
  });
  mockChatLifecycleWithoutBrowserSession({
    threadId,
    threadTitle: prefix,
    chatEvents,
  });
  const renderedStartIndex = () => {
    for (let index = 0; index <= 14; index++) {
      if (
        document.querySelector(
          `[data-chat-scroll-anchor-event-id="${prefix}-${index}"]`,
        )
      ) {
        return index;
      }
    }
    return 14;
  };
  installChatLayout(
    new Map([
      [
        threadId,
        {
          clientHeight: () => {
            return 300;
          },
          scrollHeight: () => {
            return 1200 + (14 - renderedStartIndex()) * 100;
          },
          eventRect: (eventId) => {
            const index = Number(eventId.split("-").at(-1));
            if (!Number.isFinite(index)) {
              return undefined;
            }
            return {
              top: 220 + (index - 14) * 100 + (14 - renderedStartIndex()) * 100,
              height: 80,
            };
          },
        },
      ],
    ]),
  );
  return { renderedStartIndex };
}

async function settleDetachedScrollWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function mockLiveThread({
  threadId,
  initialEvents,
  appendedEvents,
}: {
  readonly threadId: string;
  readonly initialEvents: readonly MockChatEventInput[];
  readonly appendedEvents: readonly MockChatEventInput[];
}): {
  publishAppendedEvents: () => void;
  publishAppendedEventsOnReconnect: () => void;
} {
  const inputs = [...initialEvents, ...appendedEvents].map((event) => {
    return { ...event, threadId };
  });
  const events = normalizeMockChatEvents(inputs);
  const initialCount = normalizeMockChatEvents(
    inputs.slice(0, initialEvents.length),
  ).length;
  let appendedEventsPublished = false;

  mockChatLifecycleWithoutBrowserSession({
    threadId,
    threadTitle: `Scroll position ${threadId}`,
    chatEvents: [...initialEvents],
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    const availableEvents = appendedEventsPublished
      ? events
      : events.slice(0, initialCount);
    return respond(
      200,
      chatEventRowsResponse(
        mockChatEventRows(availableEvents).filter((row) => {
          return row.seqId > query.sinceSeqId;
        }),
        query,
      ),
    );
  });

  return {
    publishAppendedEvents: () => {
      appendedEventsPublished = true;
      createChatEvent(threadId);
    },
    publishAppendedEventsOnReconnect: () => {
      appendedEventsPublished = true;
      context.mocks.ably.triggerReconnect();
    },
  };
}

function mockLateGrowingThread({
  threadId,
  prefix,
}: {
  readonly threadId: string;
  readonly prefix: string;
}): {
  readonly publishAppendedEvents: () => void;
  readonly growContent: (extraScrollHeight: number) => void;
  readonly growContentAbove: (extraScrollHeight: number) => void;
} {
  const { publishAppendedEvents } = mockLiveThread({
    threadId,
    initialEvents: simpleUserEvents(threadId, prefix, 8),
    appendedEvents: simpleUserEvents(threadId, prefix, 9).slice(8),
  });
  let extraScrollHeight = 0;
  let eventTopShift = 0;
  installChatLayout(
    new Map([
      [
        threadId,
        {
          clientHeight: () => {
            return 300;
          },
          scrollHeight: () => {
            const rendered = document.body.textContent?.includes(
              `${prefix} message 8`,
            )
              ? 1100
              : 1000;
            return rendered + extraScrollHeight;
          },
          eventRect: (eventId) => {
            const index = Number(eventId.split("-").at(-1));
            return Number.isFinite(index)
              ? { top: index * 100 + eventTopShift, height: 80 }
              : undefined;
          },
        },
      ],
    ]),
  );
  return {
    publishAppendedEvents,
    growContent: (nextExtraScrollHeight: number) => {
      extraScrollHeight = nextExtraScrollHeight;
    },
    // Content that grows above the reader — a diagram rendering in history —
    // pushes every message down by the same amount.
    growContentAbove: (nextExtraScrollHeight: number) => {
      extraScrollHeight = nextExtraScrollHeight;
      eventTopShift = nextExtraScrollHeight;
    },
  };
}

function mockKeyboardThreadScrollLayout({
  currentThreadTop,
  currentScrollHeight = () => {
    return 1200;
  },
  includeCurrentLeadingEvent = false,
}: {
  readonly currentThreadTop: () => number;
  readonly currentScrollHeight?: () => number;
  readonly includeCurrentLeadingEvent?: boolean;
}): {
  readonly beginPartialCurrentThreadReturn: () => void;
  readonly publishCurrentThreadTarget: () => void;
} {
  mockKeyboardNavigationThreads();
  let partialCurrentThreadReturn = false;
  let currentThreadTargetPublished = true;
  const currentThreadEvents = normalizeMockChatEvents([
    ...(includeCurrentLeadingEvent
      ? [
          {
            id: `${KEYBOARD_CURRENT_THREAD_ID}-cached-leading-message`,
            threadId: KEYBOARD_CURRENT_THREAD_ID,
            role: "assistant" as const,
            content: "Current thread cached leading note",
            createdAt: "2026-05-31T23:59:00Z",
          },
        ]
      : []),
    {
      id: `${KEYBOARD_CURRENT_THREAD_ID}-message`,
      threadId: KEYBOARD_CURRENT_THREAD_ID,
      role: "assistant",
      content: "Current thread launch note",
      createdAt: "2026-06-01T00:00:00Z",
    },
  ]);
  const previousThreadEvents = normalizeMockChatEvents([
    {
      id: `${KEYBOARD_PREV_THREAD_ID}-message`,
      threadId: KEYBOARD_PREV_THREAD_ID,
      role: "assistant",
      content: "Previous thread launch note",
      createdAt: "2026-06-01T00:00:00Z",
    },
  ]);
  const eventsByThreadId = new Map<string, readonly ChatEvent[]>([
    [KEYBOARD_CURRENT_THREAD_ID, currentThreadEvents],
    [KEYBOARD_PREV_THREAD_ID, previousThreadEvents],
  ]);
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      const events = eventsByThreadId.get(params.threadId) ?? [];
      const filteredEvents = events.filter((event) => {
        if (
          params.threadId === KEYBOARD_CURRENT_THREAD_ID &&
          partialCurrentThreadReturn &&
          event.id === `${KEYBOARD_CURRENT_THREAD_ID}-message` &&
          !currentThreadTargetPublished
        ) {
          return false;
        }
        return event.seqId > query.sinceSeqId;
      });
      return respond(
        200,
        chatEventRowsResponse(mockChatEventRows(filteredEvents), query),
      );
    },
  );
  installChatLayout(
    new Map([
      [
        KEYBOARD_CURRENT_THREAD_ID,
        {
          clientHeight: () => {
            return 300;
          },
          scrollHeight: currentScrollHeight,
          eventRect: (eventId) => {
            return eventId === `${KEYBOARD_CURRENT_THREAD_ID}-message`
              ? { top: currentThreadTop(), height: 80 }
              : undefined;
          },
        },
      ],
      [
        KEYBOARD_PREV_THREAD_ID,
        {
          clientHeight: () => {
            return 300;
          },
          scrollHeight: () => {
            return 600;
          },
          eventRect: (eventId) => {
            return eventId === `${KEYBOARD_PREV_THREAD_ID}-message`
              ? { top: 100, height: 80 }
              : undefined;
          },
        },
      ],
    ]),
  );
  return {
    beginPartialCurrentThreadReturn: () => {
      partialCurrentThreadReturn = true;
      currentThreadTargetPublished = false;
    },
    publishCurrentThreadTarget: () => {
      currentThreadTargetPublished = true;
      createChatEvent(KEYBOARD_CURRENT_THREAD_ID);
    },
  };
}

describe("chat scroll position", () => {
  it("does not scroll an empty thread", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000800";
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      threadTitle: "Empty scroll thread",
      chatEvents: [],
    });
    installImmediateAnimationFrames();
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return 1000;
            },
            eventRect: () => {
              return undefined;
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    await expect(
      screen.findByText("Send a message to start the conversation"),
    ).resolves.toBeInTheDocument();
    expect(chatScrollContainer().scrollTop).toBe(0);
  });

  it("opens an event hash instead of following the thread tail", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000817";
    const events = simpleUserEvents(threadId, "deep-link", 20);
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      threadTitle: "Event deep link",
      chatEvents: events,
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return 2000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}#event-deep-link-2`,
    });

    await waitFor(() => {
      expect(screen.getByText("deep-link message 2")).toBeInTheDocument();
      expect(chatScrollContainer().scrollTop).toBe(200);
      expect(viewportOffsetTop("deep-link-2")).toBe(0);
    });
  });

  it.each([
    {
      hash: "#event-%",
      label: "malformed",
      threadId: "b0000000-0000-4000-a000-000000000818",
    },
    {
      hash: `#event-${encodeURIComponent('missing-"]')}`,
      label: "unknown",
      threadId: "b0000000-0000-4000-a000-000000000819",
    },
  ])(
    "ignores a $label event hash and follows the thread tail",
    async ({ hash, threadId }) => {
      const events = simpleUserEvents(threadId, "invalid-deep-link", 20);
      mockChatLifecycleWithoutBrowserSession({
        threadId,
        threadTitle: "Invalid event deep link",
        chatEvents: events,
      });
      installChatLayout(
        new Map([
          [
            threadId,
            {
              clientHeight: () => {
                return 300;
              },
              scrollHeight: () => {
                return 2000;
              },
              eventRect: (eventId) => {
                const index = Number(eventId.split("-").at(-1));
                return Number.isFinite(index)
                  ? { top: index * 100, height: 80 }
                  : undefined;
              },
            },
          ],
        ]),
      );

      detachedSetupPage({
        context,
        path: `/chats/${threadId}${hash}`,
      });

      await waitFor(() => {
        expect(
          screen.getByText("invalid-deep-link message 19"),
        ).toBeInTheDocument();
        expect(chatScrollContainer().scrollTop).toBe(1700);
      });
    },
  );

  it("opens an encoded selector-sensitive event hash", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000820";
    const prefix = 'quoted-"event';
    const events = simpleUserEvents(threadId, prefix, 20);
    const targetEventId = `${prefix}-2`;
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      threadTitle: "Encoded event deep link",
      chatEvents: events,
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return 2000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );

    detachedSetupPage({
      context,
      path: `/chats/${threadId}#event-${encodeURIComponent(targetEventId)}`,
    });

    await waitFor(() => {
      expect(screen.getByText(`${prefix} message 2`)).toBeInTheDocument();
      expect(chatScrollContainer().scrollTop).toBe(200);
      expect(viewportOffsetTop(targetEventId)).toBe(0);
    });
  });

  it("follows the tail when a new message arrives while at the bottom", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000801";
    const initialEvents = simpleUserEvents(threadId, "tail-follow", 8);
    const appendedEvents = simpleUserEvents(threadId, "tail-follow", 9).slice(
      8,
    );
    const { publishAppendedEvents } = mockLiveThread({
      threadId,
      initialEvents,
      appendedEvents,
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return document.body.textContent?.includes(
                "tail-follow message 8",
              )
                ? 1100
                : 1000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("tail-follow message 7")).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });

    publishAppendedEvents();

    await waitFor(() => {
      expect(screen.getByText("tail-follow message 8")).toBeInTheDocument();
      expect(container.scrollTop).toBe(800);
    });
  });

  it("keeps following the tail when late content growth delivers the tail scroll event", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000809";
    const { publishAppendedEvents, growContent } = mockLateGrowingThread({
      threadId,
      prefix: "late-growth",
    });

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("late-growth message 7")).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });

    // A diagram finishes rendering after the tail scroll was written, so the
    // browser delivers that scroll event against taller content.
    growContent(400);
    fireEvent.scroll(container);

    publishAppendedEvents();

    await waitFor(() => {
      expect(screen.getByText("late-growth message 8")).toBeInTheDocument();
      expect(container.scrollTop).toBe(
        container.scrollHeight - container.clientHeight,
      );
      expect(document.querySelector("[data-scroll-to-bottom]")).toBeNull();
    });
  });

  it("follows the tail when content finishes rendering after the tail scroll", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000811";
    const { growContent } = mockLateGrowingThread({
      threadId,
      prefix: "content-growth",
    });
    const resizeObserver = installResizeObserver();

    await setupVisibleChatPage({
      context,
      path: `/chats/${threadId}`,
    });

    const container = await waitFor(() => {
      expect(screen.getByText("content-growth message 7")).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });
    const messageContainer = container.querySelector(
      "[data-message-container]",
    );
    if (!messageContainer) {
      throw new Error("Chat message container not found");
    }
    expect(resizeObserver.isObserved(messageContainer)).toBeTruthy();

    // A diagram finishes rendering well after its message was committed. Only
    // the content box changes, so the container observer never sees it.
    growContent(400);
    resizeObserver.trigger(messageContainer);

    // Asserted synchronously: the restore must happen inside the observer
    // callback, which the browser runs before painting the frame that grew the
    // content. Waiting for the next frame would paint the grown content at the
    // old offset first, which the reader sees as a flash.
    expect(container.scrollTop).toBe(
      container.scrollHeight - container.clientHeight,
    );
  });

  it("keeps following the tail when growing content delivers a second scroll event", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000815";
    const { growContent } = mockLateGrowingThread({
      threadId,
      prefix: "second-scroll",
    });
    const resizeObserver = installResizeObserver();

    await setupVisibleChatPage({
      context,
      path: `/chats/${threadId}`,
    });

    const container = await waitFor(() => {
      expect(screen.getByText("second-scroll message 7")).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });
    const messageContainer = container.querySelector(
      "[data-message-container]",
    );
    if (!messageContainer) {
      throw new Error("Chat message container not found");
    }

    // Content that keeps growing restores once per frame, and every restore
    // leaves a scroll event behind. The reader has not touched the thread, so
    // none of those events may park it — including a second one that arrives
    // before the next restore writes a new offset.
    growContent(400);
    resizeObserver.trigger(messageContainer);
    fireEvent.scroll(container);
    growContent(800);
    fireEvent.scroll(container);

    expect(document.querySelector("[data-scroll-to-bottom]")).toBeNull();
    resizeObserver.trigger(messageContainer);
    expect(container.scrollTop).toBe(
      container.scrollHeight - container.clientHeight,
    );
  });

  it("follows the tail when the anchored event stops being rendered", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000816";
    const { growContent } = mockLateGrowingThread({
      threadId,
      prefix: "anchor-gone",
    });
    const resizeObserver = installResizeObserver();

    await setupVisibleChatPage({
      context,
      path: `/chats/${threadId}`,
    });

    const container = await waitFor(() => {
      expect(screen.getByText("anchor-gone message 7")).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });
    const messageContainer = container.querySelector(
      "[data-message-container]",
    );
    if (!messageContainer) {
      throw new Error("Chat message container not found");
    }

    container.scrollTop = 300;
    fireEvent.scroll(container);
    await waitFor(() => {
      expect(document.querySelector("[data-scroll-to-bottom]")).not.toBeNull();
    });

    // Sending while a run is active queues the message, and a queued message
    // moves into the thinking indicator, which renders no anchor. The position
    // the thread is holding then points at nothing.
    for (const anchor of Array.from(
      container.querySelectorAll("[data-chat-scroll-anchor-event-id]"),
    )) {
      anchor.remove();
    }

    growContent(400);
    resizeObserver.trigger(messageContainer);

    expect(container.scrollTop).toBe(
      container.scrollHeight - container.clientHeight,
    );
    await waitFor(() => {
      expect(document.querySelector("[data-scroll-to-bottom]")).toBeNull();
    });
  });

  it("keeps the visible anchor when content above the reader grows", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000812";
    const { growContentAbove } = mockLateGrowingThread({
      threadId,
      prefix: "grow-above",
    });
    const resizeObserver = installResizeObserver();

    await setupVisibleChatPage({
      context,
      path: `/chats/${threadId}`,
    });

    const container = await waitFor(() => {
      expect(screen.getByText("grow-above message 7")).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });
    const messageContainer = container.querySelector(
      "[data-message-container]",
    );
    if (!messageContainer) {
      throw new Error("Chat message container not found");
    }
    scrollTo(container, 420);
    expect(viewportOffsetTop("grow-above-4")).toBe(-20);

    growContentAbove(400);
    resizeObserver.trigger(messageContainer);

    expect(viewportOffsetTop("grow-above-4")).toBe(-20);
    expect(container.scrollTop).toBe(820);
  });

  it("keeps the selection toolbar through an automatic anchor restore", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000821";
    const prefix = "selection-restore";
    const runIds = Array.from({ length: 8 }, (_, index) => {
      return `${prefix}-run-${index}`;
    });
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      threadTitle: "Selection restore",
      activeRunIds: runIds,
      chatEvents: runIds.map((runId, index) => {
        return {
          id: `${prefix}-${index}`,
          role: "assistant" as const,
          content: `${prefix} message ${index}`,
          runId,
          createdAt: new Date(Date.UTC(2026, 6, 30, 10, index)).toISOString(),
        };
      }),
    });
    let contentGrowth = 0;
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return 1000 + contentGrowth;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100 + contentGrowth, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );
    const resizeObserver = installResizeObserver();

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText(`${prefix} message 7`)).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });
    const messageContainer = container.querySelector(
      "[data-message-container]",
    );
    if (!messageContainer) {
      throw new Error("Chat message container not found");
    }
    scrollTo(container, 420);
    selectAssistantText(screen.getByText(`${prefix} message 4`));
    await screen.findByText("Quote");

    contentGrowth = 400;
    resizeObserver.trigger(messageContainer);
    fireEvent.scroll(container);

    expect(container.scrollTop).toBe(820);
    expect(screen.getByText("Quote")).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe(`${prefix} message 4`);

    scrollTo(container, 830);

    await waitFor(() => {
      expect(screen.queryByText("Quote")).not.toBeInTheDocument();
    });
  });

  it("keeps following the tail when a nested scroller scrolls after late content growth", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000810";
    const { publishAppendedEvents, growContent } = mockLateGrowingThread({
      threadId,
      prefix: "nested-scroll",
    });

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("nested-scroll message 7")).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });
    // Reading history and returning to the bottom leaves the thread following
    // the tail again.
    scrollTo(container, 420);
    scrollTo(container, 700);

    growContent(400);
    const messageContainer = container.querySelector(
      "[data-message-container]",
    );
    if (!messageContainer) {
      throw new Error("Chat message container not found");
    }
    // Panning a wide diagram or table sideways scrolls a nested container. The
    // capture-phase listener sees that event, but it says nothing about where
    // the thread itself sits.
    fireEvent.scroll(messageContainer);

    publishAppendedEvents();

    await waitFor(() => {
      expect(screen.getByText("nested-scroll message 8")).toBeInTheDocument();
      expect(container.scrollTop).toBe(
        container.scrollHeight - container.clientHeight,
      );
      expect(document.querySelector("[data-scroll-to-bottom]")).toBeNull();
    });
  });

  it("follows the tail when the reader sends while away from the bottom", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000806";
    const initialEvents = simpleUserEvents(threadId, "local-send-tail", 8);
    const sendGate = context.mocks.deferred<void>();
    let sent = false;
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      chatEvents: initialEvents,
      sendGate: sendGate.promise,
      onRunCreate: () => {
        sent = true;
      },
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return 1000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("local-send-tail message 7")).toBeInTheDocument();
      const current = chatScrollContainer();
      expect(current.scrollTop).toBe(700);
      return current;
    });
    scrollTo(container, 420);
    expect(viewportOffsetTop("local-send-tail-4")).toBe(-20);

    const composer = await screen.findByRole("textbox", { name: "Message" });
    await sendMessageInUI(user, composer, "Send from history");

    await waitFor(() => {
      expect(screen.getByText("Send from history")).toBeInTheDocument();
      expect(container.scrollTop).toBe(
        container.scrollHeight - container.clientHeight,
      );
    });

    sendGate.resolve();
    await waitFor(() => {
      expect(sent).toBeTruthy();
    });
  });

  it("preserves a programmatic non-bottom position when a new message arrives", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000802";
    const initialEvents = simpleUserEvents(threadId, "tail-preserve", 8);
    const appendedEvents = simpleUserEvents(threadId, "tail-preserve", 9).slice(
      8,
    );
    const { publishAppendedEvents } = mockLiveThread({
      threadId,
      initialEvents,
      appendedEvents,
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return document.body.textContent?.includes(
                "tail-preserve message 8",
              )
                ? 1100
                : 1000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("tail-preserve message 7")).toBeInTheDocument();
      return chatScrollContainer();
    });
    await waitFor(() => {
      expect(eventAnchor("tail-preserve-4")).toBeInTheDocument();
    });
    scrollTo(container, 420);
    expect(viewportOffsetTop("tail-preserve-4")).toBe(-20);

    publishAppendedEvents();

    await waitFor(() => {
      expect(screen.getByText("tail-preserve message 8")).toBeInTheDocument();
      expect(viewportOffsetTop("tail-preserve-4")).toBe(-20);
      expect(container.scrollTop).toBe(420);
    });
  });

  it("captures the current anchor after events change but before rendering", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000818";
    const initialEvents = simpleUserEvents(threadId, "after-change", 8);
    const appendedEvents = simpleUserEvents(threadId, "after-change", 9).slice(
      8,
    );
    const { publishAppendedEvents } = mockLiveThread({
      threadId,
      initialEvents,
      appendedEvents,
    });
    let contentShift = 0;
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return document.body.textContent?.includes(
                "after-change message 8",
              )
                ? 1100
                : 1000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100 + contentShift, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("after-change message 7")).toBeInTheDocument();
      return chatScrollContainer();
    });
    scrollTo(container, 420);
    expect(viewportOffsetTop("after-change-4")).toBe(-20);

    // Content can move between the last scroll event and the event mutation.
    // The change handler samples this old DOM synchronously, before React has
    // rendered the newly appended message.
    contentShift = 50;
    expect(viewportOffsetTop("after-change-4")).toBe(30);

    publishAppendedEvents();

    await waitFor(() => {
      expect(screen.getByText("after-change message 8")).toBeInTheDocument();
      expect(viewportOffsetTop("after-change-4")).toBe(30);
      expect(container.scrollTop).toBe(420);
    });
  });

  it("preserves a non-bottom anchor when reconnect catch-up appends messages", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000805";
    const initialEvents = simpleUserEvents(threadId, "reconnect-preserve", 8);
    const appendedEvents = simpleUserEvents(
      threadId,
      "reconnect-preserve",
      9,
    ).slice(8);
    const { publishAppendedEventsOnReconnect } = mockLiveThread({
      threadId,
      initialEvents,
      appendedEvents,
    });
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        agents: {},
        threads: { [threadId]: "unread" },
      });
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return document.body.textContent?.includes(
                "reconnect-preserve message 8",
              )
                ? 1100
                : 1000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(
        screen.getByText("reconnect-preserve message 7"),
      ).toBeInTheDocument();
      return chatScrollContainer();
    });
    scrollTo(container, 420);
    expect(viewportOffsetTop("reconnect-preserve-4")).toBe(-20);

    publishAppendedEventsOnReconnect();

    await waitFor(() => {
      expect(
        screen.getByText("reconnect-preserve message 8"),
      ).toBeInTheDocument();
      expect(viewportOffsetTop("reconnect-preserve-4")).toBe(-20);
      expect(container.scrollTop).toBe(420);
    });
  });

  it("preserves the visible anchor when older in-memory groups are prepended", async () => {
    const threadId = "e8000000-0000-4000-a000-000000000001";
    const chatEvents: ChatEvent[] = Array.from({ length: 24 }, (_, index) => {
      return {
        id: `prepend-anchor-${index}`,
        threadId,
        eventType: "run.completed" as const,
        content: `Prepend anchor reply ${index}`,
        runId: `prepend-anchor-run-${index}`,
        runLifecycleEvent: "completed",
        createdAt: `2026-07-30T10:${String(index).padStart(2, "0")}:00Z`,
        seqId: index + 1,
      };
    });
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      threadTitle: "Prepend anchor",
      chatEvents,
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return document.body.textContent?.includes(
                "Prepend anchor reply 4",
              )
                ? 2050
                : 1050;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              if (!Number.isFinite(index)) {
                return undefined;
              }
              const prependShift = document.body.textContent?.includes(
                "Prepend anchor reply 4",
              )
                ? 1000
                : 0;
              return {
                top: 50 + (index - 14) * 100 + prependShift,
                height: 80,
              };
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("Prepend anchor reply 23")).toBeInTheDocument();
      expect(screen.queryByText("Prepend anchor reply 13")).toBeNull();
      return chatScrollContainer();
    });
    scrollTo(container, 80);

    await waitFor(() => {
      expect(screen.getByText("Prepend anchor reply 4")).toBeInTheDocument();
      expect(viewportOffsetTop("prepend-anchor-14")).toBe(-30);
      expect(container.scrollTop).toBe(1080);
    });
  });

  it("keeps a touch-driven history scroll on one prepend window", async () => {
    const threadId = "e8000000-0000-4000-a000-000000000005";
    const prefix = "touch-prepend";
    const { renderedStartIndex } = mockVirtualizedHistoryThread({
      threadId,
      prefix,
    });

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText(`${prefix} reply 23`)).toBeInTheDocument();
      expect(renderedStartIndex()).toBe(14);
      return chatScrollContainer();
    });
    fireEvent.touchStart(container, {
      touches: [{ clientY: 500 }],
    });
    container.scrollTop = 80;
    fireEvent.touchMove(container, {
      touches: [{ clientY: 300 }],
    });
    fireEvent.scroll(container);

    await screen.findByText(`${prefix} reply 4`);
    await settleDetachedScrollWork();

    expect(renderedStartIndex()).toBe(4);
    expect(screen.queryByText(`${prefix} reply 3`)).toBeNull();
    expect(viewportOffsetTop(`${prefix}-14`)).toBe(140);
    fireEvent.touchEnd(container, { changedTouches: [{ clientY: 300 }] });
  });

  it("keeps momentum scrolling on the live history position", async () => {
    const threadId = "e8000000-0000-4000-a000-000000000006";
    const prefix = "momentum-prepend";
    const { renderedStartIndex } = mockVirtualizedHistoryThread({
      threadId,
      prefix,
    });

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText(`${prefix} reply 23`)).toBeInTheDocument();
      expect(renderedStartIndex()).toBe(14);
      return chatScrollContainer();
    });
    fireEvent.touchStart(container, {
      touches: [{ clientY: 500 }],
    });
    container.scrollTop = 120;
    fireEvent.touchMove(container, {
      touches: [{ clientY: 300 }],
    });
    fireEvent.scroll(container);
    fireEvent.touchEnd(container, { changedTouches: [{ clientY: 300 }] });

    // Safari keeps moving the scroll container after touchend while momentum
    // decays. This second scroll is browser-owned but still represents the
    // reader's newest position.
    container.scrollTop = 80;
    fireEvent.scroll(container);

    await screen.findByText(`${prefix} reply 4`);
    await settleDetachedScrollWork();

    expect(renderedStartIndex()).toBe(4);
    expect(screen.queryByText(`${prefix} reply 3`)).toBeNull();
    expect(viewportOffsetTop(`${prefix}-14`)).toBe(140);
  });

  it("restores a thread after its old DOM collapses", async () => {
    let currentThreadTargetTop = 400;
    mockKeyboardThreadScrollLayout({
      currentThreadTop: () => {
        return currentThreadTargetTop;
      },
    });

    await setupVisibleChatPage({
      context,
      path: `/chats/${KEYBOARD_CURRENT_THREAD_ID}`,
    });

    const currentContainer = await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      return chatScrollContainer();
    });
    await waitFor(() => {
      expect(
        eventAnchor(`${KEYBOARD_CURRENT_THREAD_ID}-message`),
      ).toBeInTheDocument();
    });
    scrollTo(currentContainer, 420);
    expect(viewportOffsetTop(`${KEYBOARD_CURRENT_THREAD_ID}-message`)).toBe(
      -20,
    );

    const currentThreadRegion = screen.getByLabelText("Chat thread");
    currentThreadRegion.focus();
    fireEvent.keyDown(currentThreadRegion, {
      key: "ArrowUp",
      ctrlKey: true,
      shiftKey: true,
    });
    await expect(
      screen.findByText("Previous thread launch note"),
    ).resolves.toBeInTheDocument();

    currentThreadTargetTop = 650;
    const previousThreadRegion = screen.getByLabelText("Chat thread");
    previousThreadRegion.focus();
    fireEvent.keyDown(previousThreadRegion, {
      key: "ArrowDown",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(viewportOffsetTop(`${KEYBOARD_CURRENT_THREAD_ID}-message`)).toBe(
        -20,
      );
      expect(chatScrollContainer().scrollTop).toBe(670);
    });
  });

  it("restores the visible anchor after the reader switches threads from the sidebar", async () => {
    // Opening another thread empties this container before the thread it
    // returns to has rendered, so between the two the container is as tall as
    // its viewport — which reads as "at the bottom".
    mockKeyboardThreadScrollLayout({
      currentThreadTop: () => {
        return 400;
      },
      currentScrollHeight: () => {
        return document.body.textContent?.includes("Current thread launch note")
          ? 1200
          : 300;
      },
    });

    await setupVisibleChatPage({
      context,
      path: `/chats/${KEYBOARD_CURRENT_THREAD_ID}`,
    });

    const currentContainer = await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      return chatScrollContainer();
    });
    await waitFor(() => {
      expect(
        eventAnchor(`${KEYBOARD_CURRENT_THREAD_ID}-message`),
      ).toBeInTheDocument();
    });
    scrollTo(currentContainer, 420);
    expect(viewportOffsetTop(`${KEYBOARD_CURRENT_THREAD_ID}-message`)).toBe(
      -20,
    );

    // Opening another thread from the sidebar unmounts this one. Its reader is
    // parked mid-history, and coming back must land them where they left.
    click(linkByText("Previous keyboard thread"));
    await expect(
      screen.findByText("Previous thread launch note"),
    ).resolves.toBeInTheDocument();

    click(linkByText("Current keyboard thread"));

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(viewportOffsetTop(`${KEYBOARD_CURRENT_THREAD_ID}-message`)).toBe(
        -20,
      );
      expect(chatScrollContainer().scrollTop).toBe(420);
    });
  });

  it("waits for the returned thread DOM to commit before restoring its anchor", async () => {
    installImmediateAnimationFrames();
    const { beginPartialCurrentThreadReturn, publishCurrentThreadTarget } =
      mockKeyboardThreadScrollLayout({
        currentThreadTop: () => {
          return 400;
        },
        includeCurrentLeadingEvent: true,
      });

    await setupVisibleChatPage({
      context,
      path: `/chats/${KEYBOARD_CURRENT_THREAD_ID}`,
    });

    const currentContainer = await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      return chatScrollContainer();
    });
    await waitFor(() => {
      expect(currentContainer.scrollTop).toBe(900);
    });
    scrollTo(currentContainer, 420);
    expect(viewportOffsetTop(`${KEYBOARD_CURRENT_THREAD_ID}-message`)).toBe(
      -20,
    );
    await waitFor(() => {
      expect(document.querySelector("[data-scroll-to-bottom]")).not.toBeNull();
    });

    click(linkByText("Previous keyboard thread"));
    await expect(
      screen.findByText("Previous thread launch note"),
    ).resolves.toBeInTheDocument();

    beginPartialCurrentThreadReturn();
    click(linkByText("Current keyboard thread"));
    await waitFor(() => {
      expect(
        screen.getByText("Current thread cached leading note"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Current thread launch note"),
      ).not.toBeInTheDocument();
      expect(document.querySelector("[data-scroll-to-bottom]")).not.toBeNull();
    });
    publishCurrentThreadTarget();

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(viewportOffsetTop(`${KEYBOARD_CURRENT_THREAD_ID}-message`)).toBe(
        -20,
      );
      expect(chatScrollContainer().scrollTop).toBe(420);
    });
  });

  it("keeps a run-group scroll target expanded when a new run creates a fold", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000803";
    const initialEvents: MockChatEventInput[] = [
      {
        id: "run-group-user-1",
        role: "user",
        content: "First grouped request",
        runId: "run-group-run-1",
        runGroupId: "scroll-run-group",
        createdAt: "2026-07-30T10:00:00Z",
      },
      {
        id: "run-group-assistant-1",
        role: "assistant",
        content: "First grouped reply",
        runId: "run-group-run-1",
        runGroupId: "scroll-run-group",
        createdAt: "2026-07-30T10:00:01Z",
      },
    ];
    const appendedEvents: MockChatEventInput[] = [
      {
        id: "run-group-user-2",
        role: "user",
        content: "Second grouped request",
        runId: "run-group-run-2",
        runGroupId: "scroll-run-group",
        createdAt: "2026-07-30T10:01:00Z",
      },
      {
        id: "run-group-assistant-2",
        role: "assistant",
        content: "Second grouped reply",
        runId: "run-group-run-2",
        runGroupId: "scroll-run-group",
        createdAt: "2026-07-30T10:01:01Z",
      },
    ];
    const { publishAppendedEvents } = mockLiveThread({
      threadId,
      initialEvents,
      appendedEvents,
    });
    const eventTops = new Map([
      ["run-group-user-1", 300],
      ["run-group-assistant-1", 400],
      ["run-group-user-2", 600],
      ["run-group-assistant-2", 700],
    ]);
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return 300;
            },
            scrollHeight: () => {
              return 1100;
            },
            eventRect: (eventId) => {
              const top = eventTops.get(eventId);
              return top === undefined ? undefined : { top, height: 80 };
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("First grouped reply")).toBeInTheDocument();
      return chatScrollContainer();
    });
    scrollTo(container, 420);
    expect(viewportOffsetTop("run-group-assistant-1")).toBe(-20);

    publishAppendedEvents();

    await waitFor(() => {
      expect(screen.getByText("Second grouped reply")).toBeInTheDocument();
      expect(screen.getByText("First grouped reply")).toBeInTheDocument();
      expect(viewportOffsetTop("run-group-assistant-1")).toBe(-20);
      expect(
        document.querySelector(
          "[data-chat-run-group-fold] button[aria-expanded='true']",
        ),
      ).not.toBeNull();
    });
  });

  it.each([
    {
      name: "legacy completed-work",
      runWorkFoldingEnabled: false,
      workSelector: "[data-chat-completed-work-fold]",
    },
    {
      name: "run-work",
      runWorkFoldingEnabled: true,
      workSelector: "[data-chat-run-work]",
    },
  ])(
    "keeps a $name scroll target expanded when its run finishes",
    async ({ runWorkFoldingEnabled, workSelector }) => {
      const threadId = "b0000000-0000-4000-a000-000000000804";
      const runId = "scroll-completed-work-run";
      const initialEvents: MockChatEventInput[] = [
        {
          id: "completed-work-user",
          role: "user",
          content: "Complete the release review",
          runId,
          createdAt: "2026-07-30T10:00:00Z",
        },
        {
          id: "completed-work-intermediate",
          role: "assistant",
          content: "Intermediate release analysis",
          runId,
          createdAt: "2026-07-30T10:00:01Z",
        },
      ];
      const appendedEvents: MockChatEventInput[] = [
        {
          id: "completed-work-final",
          role: "assistant",
          content: "Final release analysis",
          runId,
          runLifecycleEvent: "completed",
          createdAt: "2026-07-30T10:00:02Z",
        },
      ];
      const { publishAppendedEvents } = mockLiveThread({
        threadId,
        initialEvents,
        appendedEvents,
      });
      const eventTops = new Map([
        ["completed-work-user", 200],
        ["completed-work-intermediate", 400],
        ["completed-work-final", 600],
      ]);
      installChatLayout(
        new Map([
          [
            threadId,
            {
              clientHeight: () => {
                return 300;
              },
              scrollHeight: () => {
                return 1000;
              },
              eventRect: (eventId) => {
                const top = eventTops.get(eventId);
                return top === undefined ? undefined : { top, height: 80 };
              },
            },
          ],
        ]),
      );

      await setupVisibleChatPage({
        context,
        path: `/chats/${threadId}`,
        featureSwitches: {
          [FeatureSwitchKey.ChatRunWorkFolding]: runWorkFoldingEnabled,
        },
      });

      const container = await waitFor(() => {
        expect(
          screen.getByText("Intermediate release analysis"),
        ).toBeInTheDocument();
        return chatScrollContainer();
      });
      scrollTo(container, 420);
      expect(viewportOffsetTop("completed-work-intermediate")).toBe(-20);

      publishAppendedEvents();

      await waitFor(() => {
        expect(screen.getByText("Final release analysis")).toBeInTheDocument();
        expect(
          screen.getByText("Intermediate release analysis"),
        ).toBeInTheDocument();
        expect(viewportOffsetTop("completed-work-intermediate")).toBe(-20);
        expect(
          document.querySelector(
            `${workSelector} button[aria-expanded='true']`,
          ),
        ).not.toBeNull();
      });
    },
  );

  it("preserves its visible anchor when composer or viewport resize changes layout", async () => {
    const threadId = "e8000000-0000-4000-a000-000000000002";
    const events = simpleUserEvents(threadId, "resize-preserve", 8);
    let clientHeight = 300;
    let scrollHeight = 1000;
    let targetTop = 400;
    const resizeObserver = installResizeObserver();
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      threadTitle: "Resize preserve",
      chatEvents: events,
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return clientHeight;
            },
            scrollHeight: () => {
              return scrollHeight;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              if (!Number.isFinite(index)) {
                return undefined;
              }
              return {
                top: index === 4 ? targetTop : index * 100,
                height: 80,
              };
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({
      context,
      path: `/chats/${threadId}`,
    });

    const container = await waitFor(() => {
      expect(screen.getByText("resize-preserve message 7")).toBeInTheDocument();
      return chatScrollContainer();
    });
    const messageContainer = container.querySelector(
      "[data-message-container]",
    );
    if (!messageContainer) {
      throw new Error("Chat message container not found");
    }
    expect(resizeObserver.isObserved(container)).toBeTruthy();
    expect(resizeObserver.isObserved(messageContainer)).toBeTruthy();
    scrollTo(container, 420);
    expect(viewportOffsetTop("resize-preserve-4")).toBe(-20);

    clientHeight = 180;
    scrollHeight = 1060;
    targetTop = 460;
    resizeObserver.trigger(container);

    await waitFor(() => {
      expect(viewportOffsetTop("resize-preserve-4")).toBe(-20);
      expect(container.scrollTop).toBe(480);
    });
  });

  it("keeps following the tail when composer or viewport resize shortens it", async () => {
    const threadId = "e8000000-0000-4000-a000-000000000003";
    const events = simpleUserEvents(threadId, "resize-follow", 8);
    let clientHeight = 300;
    const resizeObserver = installResizeObserver();
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      threadTitle: "Resize follow",
      chatEvents: events,
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return clientHeight;
            },
            scrollHeight: () => {
              return 1000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              return Number.isFinite(index)
                ? { top: index * 100, height: 80 }
                : undefined;
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({ context, path: `/chats/${threadId}` });

    const container = await waitFor(() => {
      expect(screen.getByText("resize-follow message 7")).toBeInTheDocument();
      expect(chatScrollContainer().scrollTop).toBe(700);
      return chatScrollContainer();
    });

    clientHeight = 180;
    resizeObserver.trigger(container);

    await waitFor(() => {
      expect(container.scrollTop).toBe(820);
    });
  });

  it("restores the visible anchor after entering and exiting sharing", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e8000000-0000-4000-a000-000000000004";
    const events = simpleUserEvents(threadId, "sharing-transition", 8);
    const sharingActive = () => {
      return (
        document.querySelector("[data-chat-share-selectable-group]") !== null
      );
    };
    mockChatLifecycleWithoutBrowserSession({
      threadId,
      threadTitle: "Sharing transition",
      chatEvents: events,
    });
    installChatLayout(
      new Map([
        [
          threadId,
          {
            clientHeight: () => {
              return sharingActive() ? 180 : 300;
            },
            scrollHeight: () => {
              return sharingActive() ? 1060 : 1000;
            },
            eventRect: (eventId) => {
              const index = Number(eventId.split("-").at(-1));
              if (!Number.isFinite(index)) {
                return undefined;
              }
              return {
                top: index * 100 + (sharingActive() ? 60 : 0),
                height: 80,
              };
            },
          },
        ],
      ]),
    );

    await setupVisibleChatPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.SharedThreadSharing]: true,
      },
    });

    const container = await waitFor(() => {
      expect(
        screen.getByText("sharing-transition message 7"),
      ).toBeInTheDocument();
      expect(chatScrollContainer().scrollTop).toBe(700);
      return chatScrollContainer();
    });
    scrollTo(container, 420);
    expect(viewportOffsetTop("sharing-transition-4")).toBe(-20);

    await user.click(buttonByName("Share messages"));

    await waitFor(() => {
      expect(sharingActive()).toBeTruthy();
      expect(viewportOffsetTop("sharing-transition-4")).toBe(-20);
      expect(container.scrollTop).toBe(480);
    });

    await user.click(buttonByName("Cancel"));

    await waitFor(() => {
      expect(sharingActive()).toBeFalsy();
      expect(viewportOffsetTop("sharing-transition-4")).toBe(-20);
      expect(container.scrollTop).toBe(420);
    });
  });
});
