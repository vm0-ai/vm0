import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { context, detachedSetupPage } from "./chat-lifecycle-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const THINKING_INDICATOR_SELECTOR = "[data-thinking-indicator]";

function hasQueueButton(): boolean {
  return queryAllByRoleFast("button").some((button) => {
    return button.textContent === "queue...";
  });
}

function setupChatEventSequence(
  threadId: string,
  chatEvents: MockChatEventInput[],
): void {
  mockChatLifecycle(context, {
    threadId,
    chatEvents,
  });
  detachedSetupPage({ context, path: `/chats/${threadId}` });
}

describe("chat thinking indicator event sequences", () => {
  it("shows thinking for a canonical prompt while it is pending run association", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000211";
    setupChatEventSequence(threadId, [
      {
        id: "event-pending-prompt",
        role: "user",
        content: "Pending server prompt",
        runId: undefined,
        createdAt: "2026-08-30T10:45:48.424Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Pending server prompt")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(
        document.querySelector(THINKING_INDICATOR_SELECTOR),
      ).not.toBeNull();
    });
  });

  it("keeps thinking after a pending prompt is replaced by its run-associated event", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000212";
    setupChatEventSequence(threadId, [
      {
        id: "event-pending-replaced",
        role: "user",
        content: "Prompt claimed by a run",
        runId: undefined,
        createdAt: "2026-08-30T10:45:48.424Z",
      },
      {
        id: "event-run-associated",
        role: "user",
        content: "Prompt claimed by a run",
        runId: "run-associated",
        revokesEventId: "event-pending-replaced",
        createdAt: "2026-08-30T10:45:48.991Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Prompt claimed by a run")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(
        document.querySelector(THINKING_INDICATOR_SELECTOR),
      ).not.toBeNull();
    });
  });

  it("clears legacy pending state after a runless assistant response", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000218";
    setupChatEventSequence(threadId, [
      {
        id: "event-legacy-prompt",
        role: "user",
        content: "Legacy prompt without a run",
        runId: undefined,
        createdAt: "2026-08-30T10:45:48.424Z",
      },
      {
        id: "event-legacy-response",
        role: "assistant",
        content: "Legacy response without a run",
        runId: undefined,
        createdAt: "2026-08-30T10:45:48.991Z",
      },
    ]);

    await waitFor(() => {
      expect(
        screen.getByText("Legacy response without a run"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(document.querySelector(THINKING_INDICATOR_SELECTOR)).toBeNull();
    });
  });

  it("keeps the active run thinking when a later run is queued", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000213";
    setupChatEventSequence(threadId, [
      {
        id: "event-active-prompt",
        role: "user",
        content: "Active prompt",
        runId: "run-active",
        createdAt: "2026-08-30T10:45:47.000Z",
      },
      {
        id: "event-active-thinking",
        role: "assistant",
        content: null,
        thinking: "Working on the active run",
        runId: "run-active",
        createdAt: "2026-08-30T10:45:48.000Z",
      },
      {
        id: "event-queued-prompt",
        role: "user",
        content: "Queued prompt",
        runId: "run-queued",
        createdAt: "2026-08-30T10:45:49.000Z",
      },
      {
        id: "event-queued-marker",
        role: "assistant",
        content: "Waiting in queue...",
        runId: "run-queued",
        runEventId: "queue:queued",
        createdAt: "2026-08-30T10:45:50.000Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Active prompt")).toBeInTheDocument();
      expect(screen.getByText("Queued prompt")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      const indicator = document.querySelector(THINKING_INDICATOR_SELECTOR);
      if (!(indicator instanceof HTMLElement)) {
        throw new Error("Thinking indicator not found");
      }
      expect(queryAllByRoleFast("button", indicator)).toHaveLength(0);
      expect(hasQueueButton()).toBeFalsy();
    });
  });

  it("shows queue UI without thinking when the latest runnable work is only queued", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000214";
    setupChatEventSequence(threadId, [
      {
        id: "event-only-queued-prompt",
        role: "user",
        content: "Only queued prompt",
        runId: "run-only-queued",
        createdAt: "2026-08-30T10:45:49.000Z",
      },
      {
        id: "event-only-queued-marker",
        role: "assistant",
        content: "Waiting in queue...",
        runId: "run-only-queued",
        runEventId: "queue:queued",
        createdAt: "2026-08-30T10:45:50.000Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Only queued prompt")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(hasQueueButton()).toBeTruthy();
      expect(document.querySelector(THINKING_INDICATOR_SELECTOR)).toBeNull();
    });
  });

  it("keeps queue UI without thinking for a prompt behind an already queued run", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000217";
    setupChatEventSequence(threadId, [
      {
        id: "event-front-queued-prompt",
        role: "user",
        content: "Front queued prompt",
        runId: "run-front-queued",
        createdAt: "2026-08-30T10:45:48.000Z",
      },
      {
        id: "event-front-queued-marker",
        role: "assistant",
        content: "Waiting in queue...",
        runId: "run-front-queued",
        runEventId: "queue:queued",
        createdAt: "2026-08-30T10:45:49.000Z",
      },
      {
        id: "event-followup-behind-queued-run",
        role: "user",
        content: "Prompt behind queued run",
        runId: undefined,
        createdAt: "2026-08-30T10:45:50.000Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Prompt behind queued run")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(hasQueueButton()).toBeTruthy();
      expect(document.querySelector(THINKING_INDICATOR_SELECTOR)).toBeNull();
    });
  });

  it("does not turn a queued prompt into pending after the active run terminates", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000216";
    setupChatEventSequence(threadId, [
      {
        id: "event-terminating-run-prompt",
        role: "user",
        content: "Run before queued prompt",
        runId: "run-before-queued-prompt",
        createdAt: "2026-08-30T10:45:47.000Z",
      },
      {
        id: "event-prompt-queued-behind-run",
        role: "user",
        content: "Prompt queued behind run",
        runId: undefined,
        createdAt: "2026-08-30T10:45:48.000Z",
      },
      {
        id: "event-terminating-run-completed",
        role: "assistant",
        content: null,
        runId: "run-before-queued-prompt",
        runLifecycleEvent: "completed",
        createdAt: "2026-08-30T10:45:49.000Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Prompt queued behind run")).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(document.querySelector(THINKING_INDICATOR_SELECTOR)).toBeNull();
    });
  });

  it("clears pending thinking after the prompt is revoked", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000215";
    setupChatEventSequence(threadId, [
      {
        id: "event-completed-prompt",
        role: "user",
        content: "Completed prompt",
        runId: "run-completed",
        createdAt: "2026-08-30T10:45:45.000Z",
      },
      {
        id: "event-completed-output",
        role: "assistant",
        content: "Completed output",
        runId: "run-completed",
        createdAt: "2026-08-30T10:45:46.000Z",
      },
      {
        id: "event-completed-marker",
        role: "assistant",
        content: null,
        runId: "run-completed",
        runLifecycleEvent: "completed",
        createdAt: "2026-08-30T10:45:47.000Z",
      },
      {
        id: "event-revoked-prompt",
        role: "user",
        content: "Revoked pending prompt",
        runId: undefined,
        createdAt: "2026-08-30T10:45:48.000Z",
      },
      {
        id: "event-revoke-control",
        role: "user",
        content: null,
        revokesEventId: "event-revoked-prompt",
        createdAt: "2026-08-30T10:45:49.000Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Completed output")).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(document.querySelector(THINKING_INDICATOR_SELECTOR)).toBeNull();
    });
  });
});
