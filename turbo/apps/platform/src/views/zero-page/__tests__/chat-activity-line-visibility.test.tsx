import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, makeToolUseEvent } from "./chat-test-helpers.ts";

const context = testContext();

describe("activity line visibility while run is still running", () => {
  it("should keep showing activity line when result arrives but run is still running", async () => {
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

    // Wait for the active run to appear with thinking state
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // Add tool use events so the activity line shows summary steps
    ctrl.setEvents([
      makeToolUseEvent("Bash", { command: "ls" }, 1),
      {
        sequenceNumber: 2,
        eventType: "result",
        eventData: { result: "Here is the first part of the answer." },
        createdAt: "2026-03-10T00:00:30Z",
      },
      makeToolUseEvent("Read", { path: "/tmp/data.txt" }, 3),
    ]);

    // The activity line (shimmer) should remain visible while the run is still running
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // The result body should NOT appear while the run is still active (prevents layout shift)
    await waitFor(() => {
      expect(
        screen.queryByText("Here is the first part of the answer."),
      ).not.toBeInTheDocument();
    });

    // Complete the run — the result body should appear after terminal state
    ctrl.completeRun("Here is the first part of the answer.");

    await waitFor(() => {
      expect(
        screen.getByText("Here is the first part of the answer."),
      ).toBeInTheDocument();
    });
  });

  it("should hide activity line only after run reaches terminal status", async () => {
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

    // Thinking state initially
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // A result event arrives while run is still "running"
    ctrl.setEvents([
      {
        sequenceNumber: 1,
        eventType: "result",
        eventData: { result: "Intermediate result" },
        createdAt: "2026-03-10T00:00:10Z",
      },
    ]);

    // Result body should NOT be visible while run is still active (prevents layout shift)
    await waitFor(() => {
      expect(screen.queryByText("Intermediate result")).not.toBeInTheDocument();
    });

    // Activity line should still be visible (run is "running")
    expect(document.querySelector(".zero-shimmer-text")).toBeInTheDocument();

    // Now complete the run — activity line should disappear and body should appear
    ctrl.completeRun("Final result");

    await waitFor(() => {
      expect(screen.getByText("Final result")).toBeInTheDocument();
    });

    // After completion, no more shimmer/activity
    await waitFor(() => {
      expect(
        document.querySelector(".zero-shimmer-text"),
      ).not.toBeInTheDocument();
    });
  });
});
