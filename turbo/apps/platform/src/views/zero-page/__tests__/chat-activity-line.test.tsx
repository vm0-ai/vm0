import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";
import { currentChatThreadSignals$ } from "../../../signals/chat-page/create-chat-thread.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "thread-test-1";
const RUN_ID = "run-test-1";

function buildAssistantEvent(
  seq: number,
  block: { type: string; name?: string; text?: string },
): AgentEvent {
  return {
    sequenceNumber: seq,
    eventType: "assistant",
    eventData: {
      message: { content: [block] },
    },
    createdAt: "2026-03-10T00:01:00Z",
  };
}

describe("chat activity line", () => {
  it("updates activityEvents$ when runEventCreated fires with new telemetry", async () => {
    const ctrl = mockChatLifecycle({
      threadId: THREAD_ID,
      chatMessages: [
        {
          role: "user",
          content: "Hi",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Starting work",
          runId: RUN_ID,
          sequenceNumber: 5,
          status: "running",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(context.store.get(currentChatThreadSignals$)).not.toBeNull();
    });

    const thread = context.store.get(currentChatThreadSignals$)!;

    // Wait for the activity signal to pick up the tail run AND the run-event
    // Ably subscription to be registered, otherwise the trigger is missed.
    await waitFor(() => {
      expect(context.store.get(thread.activityRunId$)).toBe(RUN_ID);
      expect(hasSubscription(`runEventCreated:${RUN_ID}`)).toBeTruthy();
    });

    ctrl.setEvents([
      buildAssistantEvent(6, { type: "tool_use", name: "Bash" }),
    ]);
    triggerAblyEvent(`runEventCreated:${RUN_ID}`);

    await waitFor(async () => {
      const events = await context.store.get(thread.activityEvents$);
      expect(events).toStrictEqual([
        expect.objectContaining({ sequenceNumber: 6 }),
      ]);
    });
  });

  it("renders 'Running <tool>...' in the activity line under the last assistant group", async () => {
    const ctrl = mockChatLifecycle({
      threadId: THREAD_ID,
      chatMessages: [
        {
          role: "assistant",
          content: "Starting",
          runId: RUN_ID,
          sequenceNumber: 1,
          status: "running",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Starting")).toBeInTheDocument();
    });

    ctrl.setEvents([
      buildAssistantEvent(2, { type: "tool_use", name: "Read" }),
      buildAssistantEvent(3, { type: "tool_use", name: "Grep" }),
      buildAssistantEvent(4, { type: "tool_use", name: "Edit" }),
      buildAssistantEvent(5, { type: "tool_use", name: "Write" }),
      buildAssistantEvent(6, { type: "tool_use", name: "Bash" }),
    ]);
    triggerAblyEvent(`runEventCreated:${RUN_ID}`);

    await waitFor(() => {
      expect(screen.getByText("Running Bash...")).toBeInTheDocument();
    });

    // Only the last 3 render
    expect(screen.getByText("Running Edit...")).toBeInTheDocument();
    expect(screen.getByText("Running Write...")).toBeInTheDocument();
    expect(screen.queryByText("Running Read...")).toBeNull();
    expect(screen.queryByText("Running Grep...")).toBeNull();
  });

  it("does not render the activity line when no tail run has a sequenceNumber", async () => {
    mockChatLifecycle({
      threadId: THREAD_ID,
      chatMessages: [
        {
          role: "assistant",
          content: "Plain text",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Plain text")).toBeInTheDocument();
    });

    expect(screen.queryByText(/Running /)).toBeNull();
    expect(screen.queryByText("Thinking...")).toBeNull();
  });
});
