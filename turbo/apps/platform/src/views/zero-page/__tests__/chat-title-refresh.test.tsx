import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat title refresh", () => {
  it("should refresh sidebar after sending a message in existing thread", async () => {
    const user = userEvent.setup();
    let threadListFetchCount = 0;

    const ctrl = mockChatLifecycle({ threadTitle: "Old Title" });

    // Track how many times the thread list is fetched
    server.use(
      http.get("*/api/zero/chat-threads", () => {
        threadListFetchCount++;
        return HttpResponse.json({
          threads: [
            {
              id: "thread-test-1",
              title:
                threadListFetchCount > 1 ? "AI Generated Title" : "Old Title",
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T00:00:00Z",
              updatedAt: "2026-03-10T00:00:00Z",
            },
          ],
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    const fetchCountBeforeSend = threadListFetchCount;

    await sendMessageInUI(user, textarea, "Follow-up question");

    // Wait for sidebar to be refetched (title is generated async on the server;
    // the client schedules a delayed refresh to pick up the updated title)
    await waitFor(() => {
      expect(threadListFetchCount).toBeGreaterThan(fetchCountBeforeSend);
    });

    // Complete the run so polling stops
    ctrl.completeRun();
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });

  it("should refresh current thread data after sending a message in existing thread", async () => {
    const user = userEvent.setup();
    let threadDetailFetchCount = 0;

    const ctrl = mockChatLifecycle({ threadTitle: "Old Title" });

    // Track how many times the thread detail is fetched
    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        threadDetailFetchCount++;
        return HttpResponse.json({
          id: "thread-test-1",
          title:
            threadDetailFetchCount > 1 ? "AI Generated Title" : "Old Title",
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          unsavedRuns:
            threadDetailFetchCount > 1
              ? [
                  {
                    runId: "run-test-1",
                    status: "running",
                    prompt: "Follow-up question",
                    error: null,
                    createdAt: "2026-03-10T00:00:01Z",
                  },
                ]
              : [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    const initialFetchCount = threadDetailFetchCount;
    await sendMessageInUI(user, textarea, "Follow-up question");

    // Complete the run so polling stops — the run completion triggers a refetch
    ctrl.completeRun();
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    // After the run completes, the thread detail should have been re-fetched
    // at least once more (by the factory's reloadThread$ or the singleton's chatThreads$)
    expect(threadDetailFetchCount).toBeGreaterThan(initialFetchCount);
  });
});
