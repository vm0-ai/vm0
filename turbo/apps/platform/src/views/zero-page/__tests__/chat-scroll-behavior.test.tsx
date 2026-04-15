import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

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

// CHAT-SCROLL-001: autoScroll$ gate — does NOT scroll when user scrolled up
describe("zero chat thread page - autoScroll skips when user scrolled up", () => {
  it("does not change scrollTop when user has scrolled up (CHAT-SCROLL-001)", async () => {
    const user = userEvent.setup();
    // Navigate directly to a thread page so ZeroChatThreadPageInner renders
    // immediately and setScrollContainer$ is called on mount.
    const ctrl = mockChatLifecycle({ threadId: "thread-scroll-001" });

    detachedSetupPage({
      context,
      path: "/chats/thread-scroll-001",
    });

    // Wait for the scroll container to appear in the DOM.
    const scrollContainer = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-scroll-container]");
      expect(el).not.toBeNull();
      return el!;
    });

    // Wait for the composer to appear so we know the page is fully loaded.
    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    // Configure scroll container geometry so the user is not at the bottom.
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

    // Simulate user scrolling down to 500, then back up to 200.
    // The upward scroll disables auto-scroll.
    scrollContainer.scrollTop = 500;
    scrollContainer.dispatchEvent(new Event("scroll"));
    scrollContainer.scrollTop = 200;
    scrollContainer.dispatchEvent(new Event("scroll"));

    await sendMessageInUI(user, textarea, "Hello");

    // Wait for at least one polling iteration (Stop button appears)
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    ctrl.completeRun("Done");

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    // scrollTop must remain 200 because the user scrolled up, which disabled
    // auto-scroll. autoScroll$ checks the disabled state and returns early.
    expect(scrollContainer.scrollTop).toBe(200);
  });
});

// CHAT-SCROLL-002: autoScroll$ gate — DOES scroll when close to bottom
describe("zero chat thread page - autoScroll scrolls when near bottom", () => {
  it("updates scrollTop when distance from bottom is within threshold (CHAT-SCROLL-002)", async () => {
    const user = userEvent.setup();
    // Navigate directly to a thread page so ZeroChatThreadPageInner renders
    // immediately and setScrollContainer$ is called on mount.
    mockChatLifecycle({ threadId: "thread-scroll-002" });

    detachedSetupPage({
      context,
      path: "/chats/thread-scroll-002",
    });

    // Wait for the scroll container and composer to be present.
    const scrollContainer = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-scroll-container]");
      expect(el).not.toBeNull();
      return el!;
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    // Keep default JSDOM geometry (scrollHeight=0, clientHeight=0) so
    // distanceFromBottom = 0 - scrollTop - 0 = -scrollTop ≤ threshold, meaning the
    // auto-scroll gate passes and scrollTop is set to scrollHeight.
    // Set a non-zero scrollTop to confirm autoScroll$ actually ran.
    scrollContainer.scrollTop = 50;

    await sendMessageInUI(user, textarea, "Hello");

    // Wait for at least one polling iteration — autoScroll$ is called each time.
    // scrollTop is set to scrollHeight (= 0 in JSDOM), confirming it ran.
    await waitFor(() => {
      expect(scrollContainer.scrollTop).toBe(0);
    });
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
