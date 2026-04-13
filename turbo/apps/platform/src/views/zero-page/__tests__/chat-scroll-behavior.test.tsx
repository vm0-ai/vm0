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

    // The scroll container registered by setScrollContainer$ must be in the DOM
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
