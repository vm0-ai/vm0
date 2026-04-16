import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

describe("chat skeleton on switch", () => {
  it("should show skeleton when switching between chats", async () => {
    const threadBDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      http.get(
        "*/api/zero/chat-threads/:id/messages",
        async ({ request, params }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("sinceId")) {
            return HttpResponse.json({ messages: [], hasMore: false });
          }
          const id = params.id as string;
          if (id === "thread-b") {
            await threadBDeferred.promise;
          }
          return HttpResponse.json({
            messages: [
              {
                id: "msg-1",
                role: "user" as const,
                content: `Question for ${id}`,
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "msg-2",
                role: "assistant" as const,
                content: `Answer for ${id}`,
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
            hasMore: false,
          });
        },
      ),
      http.get("*/api/zero/chat-threads/:id", async ({ params }) => {
        const id = params.id as string;
        if (id === "thread-b") {
          await threadBDeferred.promise;
        }
        return HttpResponse.json({
          id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    // Start on thread-A — messages load immediately
    detachedSetupPage({ context, path: "/chats/thread-a" });

    await waitFor(() => {
      expect(screen.getByText("Answer for thread-a")).toBeInTheDocument();
    });

    // Switch to thread-B — API is delayed, skeleton should appear
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-b" },
    });

    // Skeleton should be visible while thread-B loads
    await waitFor(() => {
      const skeletons = document.querySelectorAll(".animate-pulse");
      expect(skeletons.length).toBeGreaterThan(0);
    });

    // Release deferred so thread-B content loads
    threadBDeferred.resolve();

    // Eventually thread-B content should load
    await waitFor(() => {
      expect(screen.getByText("Answer for thread-b")).toBeInTheDocument();
    });
  });
});
