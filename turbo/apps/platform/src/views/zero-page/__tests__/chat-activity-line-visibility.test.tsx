import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, makeToolUseEvent } from "./chat-test-helpers.ts";

const context = testContext();

describe("activity line visibility while run is still running", () => {
  it("should show activity steps when result arrives while run is still running", async () => {
    const ctrl = mockChatLifecycle({
      threadId: "thread-activity-vis",
      chatMessages: [
        {
          role: "user",
          content: "Previous message",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "user",
          content: "Do a complex multi-step task",
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-test-1",
          status: "running",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-activity-vis" });

    // Wait for the active run to appear — Stop button visible while running
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    // Add tool use events so activity steps appear
    ctrl.setEvents([
      makeToolUseEvent("Bash", { command: "ls" }, 1),
      {
        sequenceNumber: 2,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              { type: "text", text: "Here is the first part of the answer." },
            ],
          },
        },
        createdAt: "2026-03-10T00:00:30Z",
      },
      makeToolUseEvent("Read", { path: "/tmp/data.txt" }, 3),
    ]);

    // The result text is shown as it streams in via texts$
    await waitFor(() => {
      expect(
        screen.getByText("Here is the first part of the answer."),
      ).toBeInTheDocument();
    });

    // Stop button remains visible while run is still active
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();

    // Complete the run — the result body should remain visible after terminal state
    ctrl.completeRun("Here is the first part of the answer.");

    await waitFor(() => {
      expect(
        screen.getByText("Here is the first part of the answer."),
      ).toBeInTheDocument();
    });
  });

  it("should show result body when run reaches terminal status", async () => {
    const ctrl = mockChatLifecycle({
      threadId: "thread-activity-terminal",
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-test-1",
          status: "running",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-activity-terminal" });

    // Stop button visible while run is active
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    // An assistant text event arrives while run is still "running" — shown immediately via texts$
    ctrl.setEvents([
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Intermediate result" }],
          },
        },
        createdAt: "2026-03-10T00:00:10Z",
      },
    ]);

    // Result body is visible as streaming content
    await waitFor(() => {
      expect(screen.getByText("Intermediate result")).toBeInTheDocument();
    });

    // Now complete the run — body should remain and Stop should disappear
    ctrl.completeRun("Final result");

    await waitFor(() => {
      expect(screen.getByText("Final result")).toBeInTheDocument();
    });

    // After completion, Stop button is gone
    await waitFor(() => {
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });
});
