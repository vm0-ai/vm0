import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse, delay } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";

const context = testContext();

describe("chat skeleton on switch", () => {
  it("should show skeleton when switching between chats", async () => {
    server.use(
      http.get("*/api/zero/chat-threads/:id", async ({ params }) => {
        const id = params.id as string;
        if (id === "thread-b") {
          // Delay thread-B so loading state is observable
          await delay(200);
        }
        return HttpResponse.json({
          id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user" as const,
              content: `Question for ${id}`,
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              role: "assistant" as const,
              content: `Answer for ${id}`,
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
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

    // Start on thread-A — messages load immediately
    await setupPage({ context, path: "/chat/thread-a" });

    await waitFor(() => {
      expect(screen.getByText("Answer for thread-a")).toBeInTheDocument();
    });

    // Switch to thread-B — API is delayed, skeleton should appear
    context.store.set(detachedNavigateTo$, "/chat/:chatThreadId", {
      pathParams: { chatThreadId: "thread-b" },
    });

    // Skeleton should be visible while thread-B loads
    await waitFor(() => {
      const skeletons = document.querySelectorAll(".animate-pulse");
      expect(skeletons.length).toBeGreaterThan(0);
    });

    // Eventually thread-B content should load
    await waitFor(() => {
      expect(screen.getByText("Answer for thread-b")).toBeInTheDocument();
    });
  });
});
