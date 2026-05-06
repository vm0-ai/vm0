import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";

const context = testContext();
const mockApi = createMockApi(context);

type ThreadEntry = { role: "user" | "assistant"; content: string }[];

function mockThread(
  threadId: string,
  messages: ThreadEntry,
): Map<string, ThreadEntry> {
  const registry = new Map([[threadId, messages]]);
  registerThreadMocks(registry);
  return registry;
}

function registerThreadMocks(registry: Map<string, ThreadEntry>) {
  const snapshot = new Map(registry);
  server.use(
    mockApi(chatThreadMessagesContract.list, ({ params, query, respond }) => {
      const messages = snapshot.get(params.threadId) ?? [];
      if (query.sinceId) {
        return respond(200, { messages: [] });
      }
      return respond(200, {
        messages: messages.map((m, i) => {
          return {
            id: `msg-${i + 1}`,
            ...m,
            createdAt: `2026-03-10T00:00:${String(i).padStart(2, "0")}Z`,
          };
        }),
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      const messages = snapshot.get(params.id) ?? [];
      return respond(200, {
        id: params.id,
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: messages.map((m, i) => {
          return {
            ...m,
            createdAt: `2026-03-10T00:00:${String(i).padStart(2, "0")}Z`,
          };
        }),
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

// CHAT-SCROLL-004: scroll container is mounted and visible when messages load
describe("zero chat thread page - scroll container mounts on load", () => {
  it("scroll container is present in the DOM when messages are rendered (CHAT-SCROLL-004)", async () => {
    mockThread("thread-scroll-a", [
      { role: "user", content: "Hello from A" },
      { role: "assistant", content: "Reply from A" },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-scroll-a" });

    await waitFor(() => {
      expect(screen.getByText("Hello from A")).toBeInTheDocument();
    });

    const scrollContainer = document.querySelector("[data-scroll-container]");
    expect(scrollContainer).not.toBeNull();
  });
});

// CHAT-SCROLL-003: onRef cleanup sets scroll container to null on unmount
describe("zero chat thread page - scroll container is cleared on unmount", () => {
  it("clears scroll container signal when thread page unmounts on navigation (CHAT-SCROLL-003)", async () => {
    mockThread("thread-scroll-unmount", [
      { role: "user", content: "Unmount test message" },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-scroll-unmount" });

    // Wait for the scroll container to mount and the thread to render.
    await waitFor(() => {
      expect(screen.getByText("Unmount test message")).toBeInTheDocument();
    });

    const scrollContainer = document.querySelector("[data-scroll-container]");
    expect(scrollContainer).not.toBeNull();

    // Navigate away from the thread page — the ZeroChatThreadPageInner
    // component unmounts, React fires the ref cleanup, onRef's AbortController
    // aborts, and the abort listener sets internalScrollContainer$ to null.
    await context.store.set(detachedNavigateTo$, "/activities");

    await waitFor(() => {
      expect(document.querySelector("[data-scroll-container]")).toBeNull();
    });
  });
});

// CHAT-SCROLL-006: scrollToBottom$ fires unconditionally after loadMessages$
// resolves — ensures the user lands at the bottom of a completed conversation
// when opening a chat that has no active runs.
describe("zero chat thread page - scrolls to bottom after completed chat opens", () => {
  it("sets scrollTop to scrollHeight after initial messages are loaded (CHAT-SCROLL-006)", async () => {
    mockThread("thread-scroll-completed", [
      { role: "user", content: "Completed user message" },
      { role: "assistant", content: "Completed assistant reply" },
    ]);

    // Intercept the scroll container as soon as it mounts and give it non-zero
    // scrollHeight so we can verify scrollToBottom$ actually ran.
    const observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>("[data-scroll-container]");
      if (!el) {
        return;
      }
      Object.defineProperty(el, "scrollHeight", {
        get: () => {
          return 800;
        },
        configurable: true,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    detachedSetupPage({ context, path: "/chats/thread-scroll-completed" });

    await waitFor(() => {
      expect(screen.getByText("Completed user message")).toBeInTheDocument();
    });

    observer.disconnect();

    // scrollToBottom$ sets scrollTop = scrollHeight (800). Verify it fired.
    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    expect(scrollContainer).not.toBeNull();
    await waitFor(() => {
      expect(scrollContainer!.scrollTop).toBe(800);
    });
  });
});

// CHAT-SCROLL-005: scroll container persists across thread navigation because
// each thread creates its own ChatThreadSignals (and therefore its own
// setScrollContainer$), so switching threads re-registers the container
describe("zero chat thread page - scroll fires for each new thread", () => {
  it("scroll container is present after navigating to a second thread (CHAT-SCROLL-005)", async () => {
    const registry = new Map<string, ThreadEntry>([
      [
        "thread-scroll-nav-a",
        [{ role: "user", content: "Thread nav-A message" }],
      ],
      [
        "thread-scroll-nav-b",
        [{ role: "user", content: "Thread nav-B message" }],
      ],
    ]);
    registerThreadMocks(registry);

    detachedSetupPage({ context, path: "/chats/thread-scroll-nav-a" });

    // Wait for thread A to render
    await waitFor(() => {
      expect(screen.getByText("Thread nav-A message")).toBeInTheDocument();
    });

    // Navigate to thread B — a new ChatThreadSignals is created for the new
    // thread, which re-registers the scroll container via setScrollContainer$.
    await context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-scroll-nav-b" },
    });

    await waitFor(() => {
      expect(screen.getByText("Thread nav-B message")).toBeInTheDocument();
    });

    // Scroll container should still be present for the new thread
    const scrollContainer = document.querySelector("[data-scroll-container]");
    expect(scrollContainer).not.toBeNull();
  });
});

// CHAT-SCROLL-007: browser-initiated scrollTop decrease (no user input event)
// does NOT disable auto-scroll. This is the core regression guard for the PR
// fix: scroll anchoring or content shrinkage can decrease scrollTop without
// any user gesture; the scroll listener must ignore those shifts.
describe("zero chat thread page - browser-initiated scroll does not disable auto-scroll", () => {
  it("auto-scroll still fires after a scrollTop decrease with no preceding user input (CHAT-SCROLL-007)", async () => {
    mockThread("thread-browser-scroll", [
      { role: "user", content: "Browser scroll test message" },
      { role: "assistant", content: "Browser scroll test reply" },
    ]);

    // Capture the ResizeObserver callback installed by createScrollSignals so
    // we can fire it manually to simulate a content-resize event. This avoids
    // reaching into the signal store and tests through the same code path that
    // fires in production when the inner content grows.
    //
    // Only capture the first observer constructed — createScrollSignals builds
    // exactly one ResizeObserver per container bind, and we want that specific
    // callback. Using a first-capture guard prevents any additional observers
    // created by unrelated code in the render path from overwriting it.
    let capturedResizeCallback: ResizeObserverCallback | null = null;
    const originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        if (capturedResizeCallback === null) {
          capturedResizeCallback = cb;
        }
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    // Intercept the scroll container as it mounts and give it a non-zero
    // scrollHeight so we can distinguish a real scroll from a no-op.
    const mutationObserver = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>("[data-scroll-container]");
      if (!el) {
        return;
      }
      Object.defineProperty(el, "scrollHeight", {
        get: () => {
          return 900;
        },
        configurable: true,
      });
      Object.defineProperty(el, "clientHeight", {
        get: () => {
          return 300;
        },
        configurable: true,
      });
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    try {
      detachedSetupPage({ context, path: "/chats/thread-browser-scroll" });

      await waitFor(() => {
        expect(
          screen.getByText("Browser scroll test message"),
        ).toBeInTheDocument();
      });

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      expect(scrollContainer).not.toBeNull();

      // Simulate a browser-initiated scrollTop decrease (no wheel/pointer/key
      // event fires before the scroll). This mimics scroll-anchor clamping or
      // content shrinkage — NOT a deliberate user gesture.
      scrollContainer!.scrollTop = 400;
      scrollContainer!.dispatchEvent(new Event("scroll"));
      // Decrease without any user-input event:
      scrollContainer!.scrollTop = 100;
      scrollContainer!.dispatchEvent(new Event("scroll"));

      // Auto-scroll should NOT have been disabled. Prove it by firing the
      // ResizeObserver callback (the same path the browser uses when inner
      // content grows during streaming). If disabled, scrollTop stays at 100;
      // if enabled, the callback snaps it to scrollHeight.
      expect(capturedResizeCallback).not.toBeNull();
      capturedResizeCallback!([], {} as ResizeObserver);
      expect(scrollContainer!.scrollTop).toBe(scrollContainer!.scrollHeight);
    } finally {
      mutationObserver.disconnect();
      globalThis.ResizeObserver = originalRO;
    }
  });
});

// CHAT-SCROLL-008: useLastLoadable keeps previously-loaded messages visible
// while groupedChatMessages$ is in a loading state. The regression scenario is
// loaded → reloading → loaded: when the user navigates to a second thread,
// groupedChatMessages$ for the new thread returns a new Promise (initial fetch
// is pending). Without useLastLoadable (i.e. plain useLoadable), the component
// immediately receives state="loading" for the new atom, drops groups to [],
// and renders ChatSkeleton — wiping the previous thread's messages from the DOM
// before the new ones arrive. useLastLoadable keeps the previous data visible
// until the new promise settles.
describe("zero chat thread page - messages remain visible during re-fetch", () => {
  it("previously-loaded messages stay visible while the next thread's groupedChatMessages$ is pending (CHAT-SCROLL-008)", async () => {
    // Thread A resolves immediately.
    const threadLLAMessages: ThreadEntry = [
      { role: "user", content: "Thread A message" },
      { role: "assistant", content: "Thread A reply" },
    ];
    mockThread("thread-ll-a", threadLLAMessages);

    // Thread B has a deferred messages response so we can observe the
    // intermediate state while groupedChatMessages$ is in loading state.
    const threadBMessagesDeferred = createDeferredPromise<void>(context.signal);
    let resolveThreadBMessages!: () => void;

    // Override with a dispatcher-aware handler for both threads
    server.use(
      mockApi(
        chatThreadMessagesContract.list,
        async ({ params, query, respond }) => {
          if (params.threadId !== "thread-ll-b") {
            // Delegate to thread-a's data
            const msgs =
              params.threadId === "thread-ll-a" ? threadLLAMessages : [];
            if (query.sinceId) {
              return respond(200, { messages: [] });
            }
            return respond(200, {
              messages: msgs.map((m, i) => {
                return {
                  id: `msg-${i + 1}`,
                  ...m,
                  createdAt: `2026-03-10T00:00:${String(i).padStart(2, "0")}Z`,
                };
              }),
            });
          }
          if (query.sinceId) {
            return respond(200, { messages: [] });
          }
          // Initial fetch is deferred — keeps groupedChatMessages$ in loading state.
          resolveThreadBMessages = () => {
            threadBMessagesDeferred.resolve();
          };
          await threadBMessagesDeferred.promise;
          return respond(200, {
            messages: [
              {
                id: "msg-b-1",
                role: "user",
                content: "Thread B message",
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
          });
        },
      ),
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        const msgs = params.id === "thread-ll-a" ? threadLLAMessages : [];
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: msgs.map((m, i) => {
            return {
              ...m,
              createdAt: `2026-03-10T00:00:${String(i).padStart(2, "0")}Z`,
            };
          }),
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-ll-a" });

    // Wait for thread A's messages to load and render.
    await waitFor(() => {
      expect(screen.getByText("Thread A message")).toBeInTheDocument();
    });

    // Navigate to thread B — groupedChatMessages$ for the new thread instance
    // starts in a loading state (the deferred fetch above is still pending).
    await context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-ll-b" },
    });

    // While thread B's initial messages fetch is pending, thread A's messages
    // must remain in the DOM. With plain useLoadable the component would
    // immediately switch to state="loading", drop groups=[], and show
    // ChatSkeleton instead — this assertion would fail. useLastLoadable keeps
    // the previous resolved data visible until the new promise settles.
    await waitFor(() => {
      expect(screen.getByText("Thread A message")).toBeInTheDocument();
    });

    // Resolve thread B's fetch — messages should now appear and thread A's
    // messages should be replaced by thread B's.
    resolveThreadBMessages();

    await waitFor(() => {
      expect(screen.getByText("Thread B message")).toBeInTheDocument();
    });
  });
});

// CHAT-SCROLL-009: regression guard for the "skeleton → jump → bottom" glitch.
// `setupChatPage$` must scroll the list to the bottom BEFORE hiding the
// skeleton, and the message container must stay `visibility: hidden` while
// the skeleton overlay is up so the first paint the user sees is already at
// the bottom. Covers the fix in PR #9995.
describe("zero chat thread page - scrolls before hiding skeleton", () => {
  it("message container is visibility:hidden under the skeleton, and scrollTop lands at scrollHeight before the skeleton is removed (CHAT-SCROLL-009)", async () => {
    const messagesDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      mockApi(chatThreadMessagesContract.list, async ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        // Defer the initial page so we can observe the skeleton overlay
        // covering the message container with visibility:hidden beneath it.
        await messagesDeferred.promise;
        return respond(200, {
          messages: [
            {
              id: "msg-pre-1",
              role: "user" as const,
              content: "Pre-scroll user message",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: "msg-pre-2",
              role: "assistant" as const,
              content: "Pre-scroll assistant reply",
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "thread-pre-scroll",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    // Intercept the scroll container as soon as it mounts and give it a
    // non-zero scrollHeight so `scrollToBottom$` has something to scroll to.
    const observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>("[data-scroll-container]");
      if (!el) {
        return;
      }
      Object.defineProperty(el, "scrollHeight", {
        get: () => {
          return 800;
        },
        configurable: true,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      detachedSetupPage({ context, path: "/chats/thread-pre-scroll" });

      // While the messages fetch is pending, the skeleton overlay should be
      // up AND the message container should be rendered with
      // visibility:hidden (so its scrollHeight is already correct when we
      // eventually scroll).
      await waitFor(() => {
        const skeleton = document.querySelector("[data-chat-skeleton]");
        const container = document.querySelector<HTMLElement>(
          "[data-message-container]",
        );
        expect(skeleton).not.toBeNull();
        expect(container).not.toBeNull();
        expect(container!.style.visibility).toBe("hidden");
      });

      // Resolve the messages fetch — `setupChatPage$` should now scroll to
      // the bottom BEFORE hiding the skeleton.
      messagesDeferred.resolve();

      // After setup completes: skeleton is gone, container is visible, and
      // scrollTop landed at scrollHeight.
      await waitFor(() => {
        expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
      });

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      const container = document.querySelector<HTMLElement>(
        "[data-message-container]",
      );
      expect(scrollContainer).not.toBeNull();
      expect(container).not.toBeNull();
      expect(container!.style.visibility).toBe("visible");
      expect(scrollContainer!.scrollTop).toBe(800);
    } finally {
      observer.disconnect();
    }
  });
});

// Helper: install a MutationObserver that patches the scroll container's
// scrollHeight to a non-zero value as soon as it mounts. Returns the observer
// so the caller can disconnect it after the relevant assertions.
function patchScrollHeightOnMount(scrollHeight: number): MutationObserver {
  const observer = new MutationObserver(() => {
    const el = document.querySelector<HTMLElement>("[data-scroll-container]");
    if (!el) {
      return;
    }
    Object.defineProperty(el, "scrollHeight", {
      get: () => {
        return scrollHeight;
      },
      configurable: true,
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}

// CHAT-SCROLL-010: appending a queued message must auto-scroll to the bottom.
// The queued-message card renders below the message list, so when the user
// queues another message during an active run the new card should be visible
// without requiring a manual scroll. `queueMessage$` schedules an animation
// frame that sets scrollTop to scrollHeight after the data source append
// resolves — same shape as the optimistic-scroll in `sendMessage$`.
describe("zero chat thread page - queueMessage$ scrolls to bottom on append", () => {
  it("scrollTop lands at scrollHeight after the queued message is appended (CHAT-SCROLL-010)", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-queue-scroll";
    mockChatLifecycle({ threadId });

    const observer = patchScrollHeightOnMount(900);

    try {
      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      // Start an active run so the composer enters queue-message mode.
      const composer = await waitFor(() => {
        return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
      });
      await fill(composer, "start the active run");
      await user.keyboard("{Enter}");

      // Wait for the active-run composer placeholder to show, then queue
      // another message — `queueMessage$` should fire an autoScroll after the
      // pending-message append succeeds.
      const queueComposer = await waitFor(() => {
        return screen.getByPlaceholderText(
          /Type your next message/,
        ) as HTMLTextAreaElement;
      });
      await fill(queueComposer, "queued while running");
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
      });

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      expect(scrollContainer).not.toBeNull();
      await waitFor(() => {
        expect(scrollContainer!.scrollTop).toBe(scrollContainer!.scrollHeight);
      });
    } finally {
      observer.disconnect();
    }
  });
});

// CHAT-SCROLL-012: when the server consumes the queue (the previous run
// finishes and the queued message becomes a real user message), the queued-
// message card unmounts and the message-list area grows. `subscribeChatThread
// $`'s `onRunChanged$` callback tracks pending-message presence across
// reloads; when it transitions from non-null to null, it schedules an
// animationFrame that re-runs `autoScroll$` so the viewport stays pinned.
describe("zero chat thread page - autoscroll when queued message is consumed", () => {
  it("scrolls to bottom after onRunChanged$ clears the pending message (CHAT-SCROLL-012)", async () => {
    const threadId = "thread-queue-consume";
    const ctrl = mockChatLifecycle({
      threadId,
      historyMessages: [
        {
          role: "user",
          content: "First user turn",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Working on it",
          runId: "run-active",
          status: "running",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      pendingMessage: {
        content: "queued in flight",
        attachments: null,
        createdAt: "2026-03-10T00:00:02Z",
        updatedAt: "2026-03-10T00:00:02Z",
      },
    });

    const observer = patchScrollHeightOnMount(1500);

    try {
      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      // Wait for the queued card and the run-update subscription. The
      // subscription must exist before we publish the simulated event,
      // otherwise the callback never fires.
      await waitFor(() => {
        expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
        expect(
          hasSubscription(`chatThreadRunUpdated:${threadId}`),
        ).toBeTruthy();
      });

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      expect(scrollContainer).not.toBeNull();

      // Bump the container's scrollHeight to a larger value so the post-clear
      // autoScroll has somewhere new to land. If we kept the same scrollHeight
      // the assertion would still pass after the initial scroll — making the
      // test indistinguishable from "no second scroll fired."
      Object.defineProperty(scrollContainer!, "scrollHeight", {
        get: () => {
          return 2400;
        },
        configurable: true,
      });
      // Park the viewport off the bottom so we can prove autoScroll re-snaps.
      scrollContainer!.scrollTop = 0;

      // Server-side consume: drop the queued pending message, then publish
      // the run-updated event so onRunChanged$ reloads the thread, sees the
      // pending → null transition, and schedules the autoScroll.
      ctrl.clearPendingMessage();
      triggerAblyEvent(`chatThreadRunUpdated:${threadId}`);

      await waitFor(() => {
        expect(
          screen.queryByLabelText("Queued message"),
        ).not.toBeInTheDocument();
        expect(scrollContainer!.scrollTop).toBe(scrollContainer!.scrollHeight);
      });
    } finally {
      observer.disconnect();
    }
  });
});

// CHAT-SCROLL-011: opening a thread that already has a queued message must
// scroll past the queued-message card on initial paint. `setupChatThreadInit
// Scroll$` awaits `groupedChatMessages$`, then — when `threadData$.pendingMess
// age` is set — schedules a second `animationFrame` that snaps scrollTop to
// scrollHeight after the queued-message card renders below the message list.
describe("zero chat thread page - opening a thread with a queued message", () => {
  it("scrolls past the queued-message card on initial paint when pendingMessage is set (CHAT-SCROLL-011)", async () => {
    const threadId = "thread-queue-open";
    mockChatLifecycle({
      threadId,
      historyMessages: [
        {
          role: "user",
          content: "Hi while waiting",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Working on it",
          runId: "run-active",
          status: "running",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      pendingMessage: {
        content: "queued before reload",
        attachments: null,
        createdAt: "2026-03-10T00:00:02Z",
        updatedAt: "2026-03-10T00:00:02Z",
      },
    });

    const observer = patchScrollHeightOnMount(1200);

    try {
      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      // Wait for the queued-message card to render — this is the row that
      // grows the scrollable content past the message list and is the reason
      // we need a second `scrollToBottom$` after the first one.
      await waitFor(() => {
        expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
      });

      const scrollContainer = document.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
      expect(scrollContainer).not.toBeNull();
      await waitFor(() => {
        expect(scrollContainer!.scrollTop).toBe(scrollContainer!.scrollHeight);
      });
    } finally {
      observer.disconnect();
    }
  });
});
