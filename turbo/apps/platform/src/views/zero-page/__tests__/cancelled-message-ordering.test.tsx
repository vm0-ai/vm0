import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

describe("cancelled message ordering after page refresh", () => {
  it("should render cancelled message before successful message when it was created first", async () => {
    // Scenario: user sent message A (cancelled), then message B (completed).
    // After page refresh, message A should appear before message B because
    // A was created earlier.
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-ordering",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [
            {
              role: "user",
              content: "First message (cancelled)",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              role: "assistant",
              content: null,
              runId: "run-cancelled",
              status: "cancelled",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              role: "user",
              content: "Second message (completed)",
              createdAt: "2026-03-10T00:01:00Z",
            },
            {
              role: "assistant",
              content: "Reply to second message",
              createdAt: "2026-03-10T00:01:01Z",
            },
          ],
          latestSessionId: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:01:01Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-ordering" });

    await waitFor(() => {
      expect(screen.getByText("First message (cancelled)")).toBeInTheDocument();
      expect(
        screen.getByText("Second message (completed)"),
      ).toBeInTheDocument();
    });

    // Verify order: the cancelled message should appear before the completed message.
    // compareDocumentPosition bit 4 (DOCUMENT_POSITION_FOLLOWING) means the
    // second node follows the first in DOM order.
    const cancelledEl = screen.getByText("First message (cancelled)");
    const completedEl = screen.getByText("Second message (completed)");
    const position = cancelledEl.compareDocumentPosition(completedEl);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
