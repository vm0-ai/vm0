import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, makeToolUseEvent } from "./chat-test-helpers.ts";

const context = testContext();

describe("chat resume", () => {
  it("should display history messages and show thinking for active run", async () => {
    const ctrl = mockChatLifecycle({
      threadId: "thread-resume",
      chatMessages: [
        {
          role: "user",
          content: "First message",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "First reply",
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          role: "user",
          content: "Follow up question",
          createdAt: "2026-03-10T00:00:02Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-test-1",
          status: "running",
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-resume" });

    // History messages should be visible
    await waitFor(() => {
      expect(screen.getByText("First message")).toBeInTheDocument();
      expect(screen.getByText("First reply")).toBeInTheDocument();
      expect(screen.getByText("Follow up question")).toBeInTheDocument();
    });

    // Active run should show thinking state
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // Add events -- activity steps should appear
    ctrl.setEvents([makeToolUseEvent("Bash")]);

    await waitFor(() => {
      expect(screen.getByText("Running a command...")).toBeInTheDocument();
    });
  });

  it("should allow input and Stop during resume", async () => {
    mockChatLifecycle({
      threadId: "thread-resume-2",
      chatMessages: [
        {
          role: "user",
          content: "Previous message",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "user",
          content: "Active task",
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

    detachedSetupPage({ context, path: "/chats/thread-resume-2" });

    // Wait for the page to load with history
    await waitFor(() => {
      expect(screen.getByText("Active task")).toBeInTheDocument();
    });

    // Stop button should be visible during resume
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("should show failure state for resumed run that fails", async () => {
    const ctrl = mockChatLifecycle({
      threadId: "thread-resume-3",
      chatMessages: [
        {
          role: "user",
          content: "Previous message",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "user",
          content: "Active task",
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

    detachedSetupPage({ context, path: "/chats/thread-resume-3" });

    // Wait for sending state
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    // Fail the resumed run
    ctrl.failRun("Task failed unexpectedly");

    // The error message should appear in the assistant message
    await waitFor(() => {
      expect(screen.getByText(/Task failed unexpectedly/)).toBeInTheDocument();
    });
  });
});
