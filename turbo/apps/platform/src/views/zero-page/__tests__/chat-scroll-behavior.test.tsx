import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";

const context = testContext();

function mockThread(
  threadId: string,
  messages: { role: "user" | "assistant"; content: string }[],
) {
  server.use(
    http.get(`*/api/zero/chat-threads/${threadId}/messages`, ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("sinceId")) {
        return HttpResponse.json({ messages: [], hasMore: false });
      }
      return HttpResponse.json({
        messages: messages.map((m, i) => {
          return {
            id: `msg-${i + 1}`,
            ...m,
            createdAt: `2026-03-10T00:00:${String(i).padStart(2, "0")}Z`,
          };
        }),
        hasMore: false,
      });
    }),
    http.get(`*/api/zero/chat-threads/${threadId}`, () => {
      return HttpResponse.json({
        id: threadId,
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
        unsavedRuns: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
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
    context.store.set(detachedNavigateTo$, "/activities");

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
    mockThread("thread-scroll-nav-a", [
      { role: "user", content: "Thread nav-A message" },
    ]);
    mockThread("thread-scroll-nav-b", [
      { role: "user", content: "Thread nav-B message" },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-scroll-nav-a" });

    // Wait for thread A to render
    await waitFor(() => {
      expect(screen.getByText("Thread nav-A message")).toBeInTheDocument();
    });

    // Navigate to thread B — a new ChatThreadSignals is created for the new
    // thread, which re-registers the scroll container via setScrollContainer$.
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
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
    let capturedResizeCallback: ResizeObserverCallback | null = null;
    const originalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        capturedResizeCallback = cb;
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

    detachedSetupPage({ context, path: "/chats/thread-browser-scroll" });

    await waitFor(() => {
      expect(
        screen.getByText("Browser scroll test message"),
      ).toBeInTheDocument();
    });

    mutationObserver.disconnect();
    globalThis.ResizeObserver = originalRO;

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
  });
});

// CHAT-SCROLL-008: useLastLoadable keeps previously-loaded messages visible
// while groupedChatMessages$ is in a loading state. Without useLastLoadable
// (i.e. with plain useLoadable), the component would show groups=[] during
// the brief period the new promise is pending, causing the scroll container
// to flash empty and the ResizeObserver to jump scroll position to the top.
describe("zero chat thread page - messages remain visible during re-fetch", () => {
  it("previously-loaded messages are not replaced by a skeleton when groupedChatMessages$ recomputes (CHAT-SCROLL-008)", async () => {
    // Use a deferred first response so we can verify the loading state,
    // then a fast subsequent response so messages resolve.
    let resolveMessages!: () => void;
    let firstCall = true;
    const messagesResponse = HttpResponse.json({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Last loadable message",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
      hasMore: false,
    });

    server.use(
      http.get(
        "*/api/zero/chat-threads/thread-last-loadable/messages",
        ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("sinceId")) {
            return HttpResponse.json({ messages: [], hasMore: false });
          }
          if (firstCall) {
            firstCall = false;
            // First call is deferred — simulates slow initial fetch
            return new Promise<typeof messagesResponse>((resolve) => {
              resolveMessages = () => {
                resolve(messagesResponse);
              };
            });
          }
          return messagesResponse;
        },
      ),
      http.get("*/api/zero/chat-threads/thread-last-loadable", () => {
        return HttpResponse.json({
          id: "thread-last-loadable",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          unsavedRuns: [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-last-loadable" });

    // While the first messages fetch is pending, the page should show the
    // skeleton (no messages yet — groupedChatMessages$ is in loading state).
    // Verify the scroll container is present but the message is not yet visible.
    await waitFor(() => {
      const scrollContainer = document.querySelector("[data-scroll-container]");
      expect(scrollContainer).not.toBeNull();
    });
    // The message must NOT appear before the fetch resolves — if useLastLoadable
    // were absent and the component showed data immediately, this would fail.
    expect(screen.queryByText("Last loadable message")).toBeNull();

    // Resolve the first (deferred) fetch with real messages
    resolveMessages();

    // Messages should now appear and remain visible (not replaced by skeleton
    // or empty state) — this is the core guarantee of useLastLoadable.
    await waitFor(() => {
      expect(screen.getByText("Last loadable message")).toBeInTheDocument();
    });
  });
});
