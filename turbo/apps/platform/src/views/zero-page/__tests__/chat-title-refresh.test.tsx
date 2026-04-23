import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadsContract } from "@vm0/core";

const context = testContext();
const mockApi = createMockApi(context);

describe("chat title refresh", () => {
  it("should refresh sidebar after sending a message in existing thread", async () => {
    const user = userEvent.setup();
    let threadListFetchCount = 0;

    const ctrl = mockChatLifecycle({ threadTitle: "Old Title" });

    // Track how many times the thread list is fetched
    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        threadListFetchCount++;
        return respond(200, {
          threads: [
            {
              id: "thread-test-1",
              title:
                threadListFetchCount > 1 ? "AI Generated Title" : "Old Title",
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T00:00:00Z",
              updatedAt: "2026-03-10T00:00:00Z",
              isRead: false,
              isArchived: false,
              running: false,
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

    // Complete the run — sendMessage$ now awaits watchRunStatus$, so
    // reloadChatThreads$ only fires after the run reaches terminal status.
    ctrl.completeRun();

    // Wait for sidebar to be refetched (triggered by reloadChatThreads$ after run completes)
    await waitFor(() => {
      expect(threadListFetchCount).toBeGreaterThan(fetchCountBeforeSend);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });
});
