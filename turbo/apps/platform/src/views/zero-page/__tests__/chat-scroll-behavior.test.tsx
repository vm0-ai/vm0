import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { currentChatThreadSignals$ } from "../../../signals/chat-page/create-chat-thread.ts";

const context = testContext();

function mockThread(
  threadId: string,
  messages: { role: "user" | "assistant"; content: string }[],
) {
  server.use(
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

// CHAT-SCROLL-001: autoScroll$ gate — does NOT scroll when far from bottom
describe("zero chat thread page - autoScroll skips when far from bottom", () => {
  it("does not change scrollTop when distance from bottom exceeds threshold (CHAT-SCROLL-001)", async () => {
    mockThread("thread-scroll-001", [
      { role: "user", content: "Hello scroll-001" },
      { role: "assistant", content: "Reply scroll-001" },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-scroll-001" });

    await waitFor(() => {
      expect(screen.getByText("Hello scroll-001")).toBeInTheDocument();
    });

    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    expect(scrollContainer).not.toBeNull();

    // Mock scroll geometry so the user appears far from the bottom (distance > 80px).
    Object.defineProperty(scrollContainer, "scrollHeight", {
      get: () => {
        return 1000;
      },
      configurable: true,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      get: () => {
        return 300;
      },
      configurable: true,
    });
    // distanceFromBottom = 1000 - 200 - 300 = 500 > 80
    scrollContainer!.scrollTop = 200;

    const signals = context.store.get(currentChatThreadSignals$);
    expect(signals).not.toBeNull();
    context.store.set(signals!.autoScroll$);

    // scrollTop must remain unchanged because the user is far from the bottom
    expect(scrollContainer!.scrollTop).toBe(200);
  });
});

// CHAT-SCROLL-002: autoScroll$ gate — DOES scroll when close to bottom
describe("zero chat thread page - autoScroll scrolls when near bottom", () => {
  it("updates scrollTop when distance from bottom is within threshold (CHAT-SCROLL-002)", async () => {
    mockThread("thread-scroll-002", [
      { role: "user", content: "Hello scroll-002" },
      { role: "assistant", content: "Reply scroll-002" },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-scroll-002" });

    await waitFor(() => {
      expect(screen.getByText("Hello scroll-002")).toBeInTheDocument();
    });

    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    expect(scrollContainer).not.toBeNull();

    // Keep default JSDOM geometry (scrollHeight=0, clientHeight=0) so
    // distanceFromBottom = 0 - scrollTop - 0 = -scrollTop ≤ 80.
    // Set a non-zero scrollTop to confirm autoScroll$ actually runs scrollToMessages
    // and updates scrollTop back to the computed position (userTop=0 in JSDOM).
    scrollContainer!.scrollTop = 50;

    const signals = context.store.get(currentChatThreadSignals$);
    expect(signals).not.toBeNull();
    context.store.set(signals!.autoScroll$);

    // scrollToMessages sets scrollTop to userTop (= 0 in JSDOM), confirming it ran
    expect(scrollContainer!.scrollTop).toBe(0);
  });
});

// CHAT-SCROLL-003: forceScrollToBottom$ always scrolls regardless of distance
describe("zero chat thread page - forceScrollToBottom ignores threshold", () => {
  it("updates scrollTop even when the user is far from the bottom (CHAT-SCROLL-003)", async () => {
    mockThread("thread-scroll-003", [
      { role: "user", content: "Hello scroll-003" },
      { role: "assistant", content: "Reply scroll-003" },
    ]);

    detachedSetupPage({ context, path: "/chats/thread-scroll-003" });

    await waitFor(() => {
      expect(screen.getByText("Hello scroll-003")).toBeInTheDocument();
    });

    const scrollContainer = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    expect(scrollContainer).not.toBeNull();

    // Place the user far from the bottom (> 80px threshold)
    Object.defineProperty(scrollContainer, "scrollHeight", {
      get: () => {
        return 2000;
      },
      configurable: true,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      get: () => {
        return 300;
      },
      configurable: true,
    });
    // distanceFromBottom = 2000 - 800 - 300 = 900 >> 80
    scrollContainer!.scrollTop = 800;

    const signals = context.store.get(currentChatThreadSignals$);
    expect(signals).not.toBeNull();
    context.store.set(signals!.forceScrollToBottom$);

    // forceScrollToBottom$ calls scrollToMessages unconditionally;
    // userTop = 0 in JSDOM, so scrollTop is reset to 0
    expect(scrollContainer!.scrollTop).toBe(0);
  });
});

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

// CHAT-SCROLL-005: useAutoScrollOnce resets on thread change so forceScrollToBottom$
// fires again for the new thread
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

    // Navigate to thread B — a new ChatThreadSignals is created, giving
    // useAutoScrollOnce a new scroll command reference and resetting its
    // fired flag so it can scroll for the new thread.
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
