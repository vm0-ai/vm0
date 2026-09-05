import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const ROW_HEIGHT = 36;

function threadId(index: number): string {
  return `b3200000-0000-4000-a000-${String(index).padStart(12, "0")}`;
}

function mockThreads(count: number): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: Array.from({ length: count }, (_, index) => {
        return {
          id: threadId(index),
          agentId: AGENT_ID,
          title: `History ${index + 1}`,
          sortAt: new Date(
            Date.parse("2026-03-10T00:00:00Z") + (count - index) * 1000,
          ).toISOString(),
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        };
      }),
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {} });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
}

function mockViewportResize(): (target: HTMLElement) => void {
  const observers = new Set<TestResizeObserver>();

  class TestResizeObserver implements ResizeObserver {
    private targets = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(target: Element): void {
      this.targets.add(target);
      observers.add(this);
    }

    unobserve(target: Element): void {
      this.targets.delete(target);
    }

    disconnect(): void {
      this.targets = new Set();
      observers.delete(this);
    }

    resize(target: HTMLElement): void {
      if (!this.targets.has(target)) {
        return;
      }
      const contentRect = target.getBoundingClientRect();
      const size = {
        inlineSize: contentRect.width,
        blockSize: contentRect.height,
      };
      this.callback(
        [
          {
            target,
            contentRect,
            borderBoxSize: [size],
            contentBoxSize: [size],
            devicePixelContentBoxSize: [size],
          },
        ],
        this,
      );
    }
  }

  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  return (target) => {
    act(() => {
      for (const observer of observers) {
        observer.resize(target);
      }
    });
  };
}

function queueAnimationFrames(): () => void {
  let nextFrameId = 0;
  let callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrameId += 1;
    callbacks.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    callbacks.delete(frameId);
  });

  return () => {
    act(() => {
      const scheduled = Array.from(callbacks.values());
      callbacks = new Map();
      for (const callback of scheduled) {
        callback(performance.now());
      }
    });
  };
}

test.each([
  { baseUi: false, threadCount: 120, initialHeight: 120 * ROW_HEIGHT },
  { baseUi: true, threadCount: 120, initialHeight: 120 * ROW_HEIGHT },
  { baseUi: false, threadCount: 6406, initialHeight: 0 },
  { baseUi: true, threadCount: 6406, initialHeight: 0 },
])(
  "Keep $threadCount sidebar threads virtualized after layout settles (baseUi=$baseUi)",
  async ({ baseUi, threadCount, initialHeight }) => {
    mockThreads(threadCount);
    context.mocks.browser.noAnimations();
    const resize = mockViewportResize();
    let viewportHeight = initialHeight;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "sidebar-scroll-area"
          ? viewportHeight
          : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "sidebar-scroll-area"
          ? threadCount * ROW_HEIGHT
          : 0;
      },
    );

    await setupPage({
      context,
      path: `/chats/${threadId(0)}`,
      featureSwitches: {
        [FeatureSwitchKey.BaseUiSidebarScrollArea]: baseUi,
      },
    });

    const sidebar = screen.getByTestId("chat-list-column");
    const rows = () => {
      return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
    };
    await waitFor(() => {
      expect(rows()).toHaveLength(initialHeight ? threadCount : 100);
    });

    // Model stylesheet activation without a scroll event. The smaller
    // unbounded fixture exercises the same transition without mounting 6,406
    // rows in happy-dom; the large fixture also verifies the 100-row fallback.
    const viewport = within(sidebar).getByTestId("sidebar-scroll-area");
    viewportHeight = 612;
    resize(viewport);
    await waitFor(() => {
      expect(rows()).toHaveLength(25);
    });
    expect(within(sidebar).getByText("History 25")).toBeInTheDocument();
    expect(within(sidebar).queryByText("History 26")).not.toBeInTheDocument();

    viewportHeight = 900;
    resize(viewport);
    await waitFor(() => {
      expect(within(sidebar).getByText("History 33")).toBeInTheDocument();
    });
    expect(rows()).toHaveLength(33);

    viewportHeight = 360;
    resize(viewport);
    await waitFor(() => {
      expect(rows()).toHaveLength(18);
    });

    const nextThread = queryAllByRoleFast("link", sidebar).find((link) => {
      return link.getAttribute("href") === `/chats/${threadId(1)}`;
    });
    if (!nextThread) {
      throw new Error("Second sidebar thread is not mounted");
    }
    click(nextThread);
    await waitFor(() => {
      expect(nextThread).toHaveAttribute("aria-current", "page");
    });
    expect(rows()).toHaveLength(18);
  },
);

test("Coalesce sidebar resize bursts and cancel pending measurements when hidden", async () => {
  mockThreads(120);
  const resize = mockViewportResize();
  await setupPage({
    context,
    path: `/chats/${threadId(0)}`,
    featureSwitches: {
      [FeatureSwitchKey.BaseUiSidebarScrollArea]: false,
    },
  });

  const sidebar = screen.getByTestId("chat-list-column");
  const rows = () => {
    return within(sidebar).getAllByTestId("sidebar-chat-thread-virtual-row");
  };
  await waitFor(() => {
    expect(rows()).toHaveLength(100);
  });

  const viewport = within(sidebar).getByTestId("sidebar-scroll-area");
  let viewportHeight = 120 * ROW_HEIGHT;
  let heightReads = 0;
  vi.spyOn(viewport, "clientHeight", "get").mockImplementation(() => {
    heightReads += 1;
    return viewportHeight;
  });
  vi.spyOn(viewport, "scrollHeight", "get").mockReturnValue(120 * ROW_HEIGHT);
  const flushFrame = queueAnimationFrames();

  resize(viewport);
  viewportHeight = 900;
  resize(viewport);
  viewportHeight = 360;
  resize(viewport);

  // Intermediate layouts must not force repeated geometry reads. The single
  // frame measurement must use the latest height and update the visible rows.
  expect(heightReads).toBe(0);
  flushFrame();
  expect(heightReads).toBe(1);
  await waitFor(() => {
    expect(rows()).toHaveLength(18);
  });

  heightReads = 0;
  viewportHeight = 900;
  resize(viewport);
  click(within(sidebar).getByLabelText("Hide chat list"));
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  });
  resize(viewport);
  flushFrame();
  expect(heightReads).toBe(0);
});
